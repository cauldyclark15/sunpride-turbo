package com.sunpride.van.pos

import com.sunpride.van.data.Customer
import com.sunpride.van.data.Product
import java.math.BigDecimal
import java.math.MathContext
import java.time.LocalDate
import java.util.UUID

/**
 * VAN-019 customer product returns. Pure and shared: the return screens use these rules to show the seller
 * what is wrong, and `ReturnStore.commit` runs them again inside the Room transaction that saves the return,
 * so the products, sale and stock checked are the ones the return is written against.
 *
 * What happens to the goods (the disposition) decides the truck-stock movement, and some returns need the
 * office's approval. Goods waiting for approval never become sellable: they are held with the damaged stock.
 */

/** What happens to the returned goods. */
enum class ReturnDisposition(val wire: String, val label: String) {
    /** Sealed and good: back into sellable truck stock (only when no approval is needed). */
    RESELLABLE("resellable", "Good stock — sell again"),
    /** Bad order: kept on the truck with the damaged stock and taken back to the warehouse. */
    BAD_STOCK("bad_stock", "Bad order — back to warehouse"),
    /** Thrown away at the store (spoiled, leaking): nothing comes back on the truck. */
    DISPOSED_AT_OUTLET("disposed_at_outlet", "Thrown away at the store");
    companion object { fun of(wire: String) = entries.single { it.wire == wire } }
}

/** The truck-stock movement a return line makes: `available`, `damaged` or none at all. */
enum class ReturnStockEffect(val wire: String) { AVAILABLE("available"), DAMAGED("damaged"), NONE("none") }

/** Why a return needs the office's approval. */
enum class ReturnApprovalReason(val wire: String) {
    /** The goods are thrown away at the store, so nothing comes back to check. */
    DISPOSED_AT_OUTLET("disposed_at_outlet"),
    /** The reason/disposition pair always needs approval (e.g. quality complaint, near-expiry resale). */
    POLICY("policy"),
    /** Not linked to a sale on this phone: the office checks the goods were bought from Sunpride. */
    NOT_LINKED_TO_SALE("not_linked_to_sale"),
    /** A walk-in customer saved only on this phone. */
    WALK_IN("walk_in"),
}

/** One allowed disposition for a reason, and whether that pair always needs approval. */
data class ReturnDispositionRule(val disposition: ReturnDisposition, val approvalRequired: Boolean = false)

/** One return reason: the dispositions allowed for it and whether the batch/lot number must be captured. */
data class ReturnReasonRule(val code: String, val label: String, val dispositions: List<ReturnDispositionRule>, val batchRequired: Boolean)

/**
 * The return policy. Sunpride has not given its return rules yet (VAN-019): [DEFAULT] is our assumption,
 * documented in `docs/ARCHITECTURE.md`, kept in one place so an office-configured policy can replace it.
 */
data class ReturnPolicy(val reasons: List<ReturnReasonRule>, val unlinkedNeedsApproval: Boolean = true, val walkInNeedsApproval: Boolean = true) {
    fun reason(code: String?): ReturnReasonRule? = reasons.firstOrNull { it.code == code }
    companion object {
        private val GOOD = ReturnDispositionRule(ReturnDisposition.RESELLABLE)
        private val BAD = ReturnDispositionRule(ReturnDisposition.BAD_STOCK)
        private val DISPOSED = ReturnDispositionRule(ReturnDisposition.DISPOSED_AT_OUTLET, approvalRequired = true)
        val DEFAULT = ReturnPolicy(listOf(
            ReturnReasonRule("damaged", "Damaged (crushed, dented, leaking)", listOf(BAD, DISPOSED), batchRequired = false),
            ReturnReasonRule("expired", "Expired", listOf(BAD, DISPOSED), batchRequired = true),
            ReturnReasonRule("spoiled", "Spoiled", listOf(BAD, DISPOSED), batchRequired = true),
            ReturnReasonRule("near_expiry", "Near expiry", listOf(BAD, ReturnDispositionRule(ReturnDisposition.RESELLABLE, approvalRequired = true)), batchRequired = true),
            ReturnReasonRule("quality_complaint", "Quality complaint", listOf(ReturnDispositionRule(ReturnDisposition.BAD_STOCK, approvalRequired = true)), batchRequired = true),
            ReturnReasonRule("wrong_item", "Wrong item delivered", listOf(GOOD, BAD), batchRequired = false),
            ReturnReasonRule("overstock", "Not selling / overstock", listOf(GOOD, BAD), batchRequired = false),
        ))
    }
}

/** A unit the seller can count a returned product in: the product's own UOM or a case with a known size. */
data class ReturnUnit(val uomCode: String, val baseQuantity: Long)

/**
 * One returned product line. [quantityBase] is integral base units; [uomCode] is the unit the seller counted
 * in and must divide [quantityBase] exactly. [lotNumber]/[expiryDate] (ISO date) are what is printed on the pack.
 */
data class ReturnLineInput(val productId: String, val uomCode: String, val quantityBase: Long, val reasonCode: String?,
    val disposition: ReturnDisposition?, val lotNumber: String? = null, val expiryDate: String? = null)

/** [returnId] is a UUID-v4 made when the return opens; it makes Save return safe to tap twice. */
data class ReturnRequest(val returnId: String, val customerId: String?, val originalSaleId: String?, val lines: List<ReturnLineInput>, val note: String? = null)

/** A sale saved on this phone, as far as returns need it: what was sold to whom. */
data class SoldSale(val saleId: String, val receiptNumber: String, val customerId: String, val createdAt: Long, val soldBase: Map<String, Long>)

enum class ReturnProblem {
    TRIP_NOT_OPEN, NO_CUSTOMER, UNKNOWN_CUSTOMER, EMPTY, TOO_MANY_LINES, DUPLICATE_LINE, UNKNOWN_PRODUCT, UNKNOWN_UNIT,
    BAD_QUANTITY, NO_REASON, NO_DISPOSITION, DISPOSITION_NOT_ALLOWED, BATCH_MISSING, BATCH_INVALID, EXPIRY_INVALID,
    UNKNOWN_SALE, SALE_OTHER_CUSTOMER, NOT_ON_SALE, MORE_THAN_SOLD, NOTE_INVALID
}

data class ReturnIssue(val problem: ReturnProblem, val productId: String? = null)

data class QuotedReturnLine(val lineNumber: Int, val product: Product, val unit: ReturnUnit, val quantityBase: Long,
    val reason: ReturnReasonRule, val disposition: ReturnDisposition, val stockEffect: ReturnStockEffect, val approvalRequired: Boolean,
    val lotNumber: String?, val expiryDate: String?) {
    /** Quantity in the unit the seller counted in (e.g. "2" CS). */
    val unitQuantity: String get() = BigDecimal.valueOf(quantityBase).divide(BigDecimal.valueOf(unit.baseQuantity), MathContext.DECIMAL128).stripTrailingZeros().toPlainString()
}

/** [approvalReasons] is empty when the return needs no approval. */
data class ReturnQuote(val lines: List<QuotedReturnLine>, val sale: SoldSale?, val approvalReasons: List<ReturnApprovalReason>, val note: String?) {
    val approvalRequired: Boolean get() = approvalReasons.isNotEmpty()
    /** Truck stock movement per product and status: what the ledger records (positive, base units). */
    val stockChanges: Map<Pair<String, ReturnStockEffect>, Long> get() = lines.filter { it.stockEffect != ReturnStockEffect.NONE }
        .groupBy { it.product.productId to it.stockEffect }.mapValues { (_, l) -> l.fold(0L) { sum, line -> Math.addExact(sum, line.quantityBase) } }
}

data class ReturnResult(val quote: ReturnQuote?, val issues: List<ReturnIssue>) {
    val ok: Boolean get() = quote != null && issues.isEmpty()
}

/**
 * Everything a return is checked against, read from the scoped encrypted store. [returnedBase] is, per sale on
 * this phone, the base quantity per product already returned against it.
 */
data class ReturnContext(val tripOpen: Boolean, val customers: List<Customer>, val products: List<Product>,
    val sales: List<SoldSale>, val returnedBase: Map<String, Map<String, Long>>, val policy: ReturnPolicy = ReturnPolicy.DEFAULT)

class ReturnRefused(val issues: List<ReturnIssue>) : IllegalStateException("Return refused")

/** The saved return as shown to the seller. */
data class ReturnReceipt(val returnId: String, val returnNumber: String, val customerName: String, val saleReceiptNumber: String?,
    val lines: List<QuotedReturnLine>, val approvalReasons: List<ReturnApprovalReason>, val status: String, val createdAt: Long, val replay: Boolean = false)

object ReturnRules {
    const val MAX_LINES = 50
    const val MAX_BASE = 999_999_999_999_999_999L
    const val STATUS_AWAITING_APPROVAL = "awaiting_approval"
    const val STATUS_RECORDED = "recorded"
    private val uuidV4 = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    private val lotPattern = Regex("^[A-Z0-9][A-Z0-9 ./-]{0,39}$")

    fun newReturnId(): String = UUID.randomUUID().toString()

    /** The product's own UOM first, then each case/pack size the office set an exact base quantity for. */
    fun units(product: Product): List<ReturnUnit> = (listOf(ReturnUnit(product.uomCode, product.quantityScale)) +
        product.barcodeUnits.mapNotNull { u -> u.baseQuantity?.takeIf { it > 0 }?.let { ReturnUnit(u.uomCode, it) } })
        .distinctBy { it.uomCode }

    /** Lot/batch number as printed: trimmed, single-spaced, upper case; letters, digits, space, `-`, `/`, `.`; 1–40. */
    fun normalizeLot(text: String?): String? {
        val value = text?.trim()?.replace(Regex("\\s+"), " ")?.uppercase() ?: return null
        return value.takeIf { lotPattern.matches(it) }
    }

    /** An ISO date (yyyy-MM-dd) between 2000 and 2100, or null. */
    fun parseExpiry(text: String?): String? = text?.trim()?.takeIf { it.isNotEmpty() }?.let {
        runCatching { LocalDate.parse(it) }.getOrNull()?.takeIf { d -> d.year in 2000..2100 }?.toString()
    }

    /** What a line does to truck stock: goods waiting for approval are held with damaged stock, never sellable. */
    fun stockEffect(disposition: ReturnDisposition, approvalRequired: Boolean): ReturnStockEffect = when (disposition) {
        ReturnDisposition.RESELLABLE -> if (approvalRequired) ReturnStockEffect.DAMAGED else ReturnStockEffect.AVAILABLE
        ReturnDisposition.BAD_STOCK -> ReturnStockEffect.DAMAGED
        ReturnDisposition.DISPOSED_AT_OUTLET -> ReturnStockEffect.NONE
    }

    fun evaluate(request: ReturnRequest, context: ReturnContext): ReturnResult {
        require(uuidV4.matches(request.returnId)) { "Return ID must be a UUID-v4" }
        val issues = mutableListOf<ReturnIssue>()
        val policy = context.policy
        if (!context.tripOpen) issues += ReturnIssue(ReturnProblem.TRIP_NOT_OPEN)
        val customer = context.customers.firstOrNull { it.outletId == request.customerId }
        when {
            request.customerId.isNullOrBlank() -> issues += ReturnIssue(ReturnProblem.NO_CUSTOMER)
            customer == null -> issues += ReturnIssue(ReturnProblem.UNKNOWN_CUSTOMER)
        }
        val note = request.note?.trim()?.takeIf { it.isNotEmpty() }
        if (note != null && (note.length > 300 || note.any(Char::isISOControl))) issues += ReturnIssue(ReturnProblem.NOTE_INVALID)
        if (request.lines.isEmpty()) issues += ReturnIssue(ReturnProblem.EMPTY)
        if (request.lines.size > MAX_LINES) issues += ReturnIssue(ReturnProblem.TOO_MANY_LINES)

        // A linked sale must be one saved on this phone for the same customer.
        val sale = request.originalSaleId?.let { id -> context.sales.firstOrNull { it.saleId == id } }
        if (request.originalSaleId != null) when {
            sale == null -> issues += ReturnIssue(ReturnProblem.UNKNOWN_SALE)
            sale.customerId != request.customerId -> issues += ReturnIssue(ReturnProblem.SALE_OTHER_CUSTOMER)
        }

        val products = context.products.associateBy { it.productId }
        val quoted = mutableListOf<QuotedReturnLine>()
        val seen = mutableSetOf<List<Any?>>()
        // Return-level approval reasons apply to every line (a resellable line then stays held).
        val headerApproval = buildList {
            if (request.originalSaleId == null && policy.unlinkedNeedsApproval) add(ReturnApprovalReason.NOT_LINKED_TO_SALE)
            if (customer?.localOnly == true && policy.walkInNeedsApproval) add(ReturnApprovalReason.WALK_IN)
        }
        val lineApproval = mutableSetOf<ReturnApprovalReason>()
        request.lines.forEachIndexed { index, line ->
            val product = products[line.productId]
            if (product == null) { issues += ReturnIssue(ReturnProblem.UNKNOWN_PRODUCT, line.productId); return@forEachIndexed }
            val unit = units(product).firstOrNull { it.uomCode == line.uomCode }
            if (unit == null) { issues += ReturnIssue(ReturnProblem.UNKNOWN_UNIT, line.productId); return@forEachIndexed }
            // The product's own unit may be fractional (1.5 KG = 1500 g base); a case/pack counts whole packs only.
            if (line.quantityBase !in 1L..MAX_BASE || unit.uomCode != product.uomCode && line.quantityBase % unit.baseQuantity != 0L) {
                issues += ReturnIssue(ReturnProblem.BAD_QUANTITY, line.productId); return@forEachIndexed
            }
            val reason = policy.reason(line.reasonCode)
            if (reason == null) { issues += ReturnIssue(ReturnProblem.NO_REASON, line.productId); return@forEachIndexed }
            if (line.disposition == null) { issues += ReturnIssue(ReturnProblem.NO_DISPOSITION, line.productId); return@forEachIndexed }
            val rule = reason.dispositions.firstOrNull { it.disposition == line.disposition }
            if (rule == null) { issues += ReturnIssue(ReturnProblem.DISPOSITION_NOT_ALLOWED, line.productId); return@forEachIndexed }
            val lot = normalizeLot(line.lotNumber)
            when {
                line.lotNumber.isNullOrBlank() -> if (reason.batchRequired) { issues += ReturnIssue(ReturnProblem.BATCH_MISSING, line.productId); return@forEachIndexed }
                lot == null -> { issues += ReturnIssue(ReturnProblem.BATCH_INVALID, line.productId); return@forEachIndexed }
            }
            val expiry = parseExpiry(line.expiryDate)
            if (!line.expiryDate.isNullOrBlank() && expiry == null) { issues += ReturnIssue(ReturnProblem.EXPIRY_INVALID, line.productId); return@forEachIndexed }
            if (!seen.add(listOf(product.productId, lot, reason.code, rule.disposition, expiry))) {
                issues += ReturnIssue(ReturnProblem.DUPLICATE_LINE, line.productId); return@forEachIndexed
            }
            val approval = buildSet {
                if (rule.disposition == ReturnDisposition.DISPOSED_AT_OUTLET) add(ReturnApprovalReason.DISPOSED_AT_OUTLET)
                else if (rule.approvalRequired) add(ReturnApprovalReason.POLICY)
                addAll(headerApproval)
            }
            lineApproval += approval
            quoted += QuotedReturnLine(index + 1, product, unit, line.quantityBase, reason, rule.disposition,
                stockEffect(rule.disposition, approval.isNotEmpty()), approval.isNotEmpty(), lot, expiry)
        }

        // Never return more of a product than this sale sold, counting earlier returns against it.
        if (sale != null && sale.customerId == request.customerId) {
            val already = context.returnedBase[sale.saleId] ?: emptyMap()
            quoted.groupBy { it.product.productId }.forEach { (productId, lines) ->
                val sold = sale.soldBase[productId]
                val asked = lines.fold(0L) { sum, l -> Math.addExact(sum, l.quantityBase) }
                when {
                    sold == null -> issues += ReturnIssue(ReturnProblem.NOT_ON_SALE, productId)
                    Math.addExact(already[productId] ?: 0L, asked) > sold -> issues += ReturnIssue(ReturnProblem.MORE_THAN_SOLD, productId)
                }
            }
        }
        if (issues.isNotEmpty()) return ReturnResult(null, issues.distinct())
        val reasons = ReturnApprovalReason.entries.filter { it in lineApproval || it in headerApproval }
        return ReturnResult(ReturnQuote(quoted, sale, reasons, note), emptyList())
    }
}
