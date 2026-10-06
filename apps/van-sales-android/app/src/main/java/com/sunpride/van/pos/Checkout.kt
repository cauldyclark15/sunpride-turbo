package com.sunpride.van.pos

import com.sunpride.van.data.Customer
import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.PaymentMethod
import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import com.sunpride.van.data.VanPolicy
import java.math.BigInteger
import java.util.UUID

/**
 * VAN-011 checkout rules. Pure and shared: the screens use them to show the seller what is wrong, and
 * `RoomVanStore.commitSale` runs them again inside the Room transaction that saves the sale, so the
 * stock, price and customer checked are the ones the sale is written against.
 */

/** One cart line: a product and a quantity in base units (integral, never a float). */
data class CartLine(val productId: String, val quantityBase: Long)

/**
 * VAN-012: the payment the seller records. [methodCode] is one of the office's configured methods
 * (`VanPolicy.paymentMethods`); [tenderedMinor] is the cash handed over (cash only, centavos);
 * [reference] is the check/e-wallet/bank number when the method needs one.
 */
data class PaymentInput(val methodCode: String, val tenderedMinor: Long? = null, val reference: String? = null)

/** Payment state, kept apart from the sale's posting state: a sale can be saved while its payment is still to be confirmed. */
enum class PaymentState(val wire: String) { PAID("paid"), AWAITING_CONFIRMATION("awaiting_confirmation"), ON_ACCOUNT("on_account") }

/** The payment as it will be saved. [dueDate] (Manila date) only for credit. */
data class QuotedPayment(val method: PaymentMethod, val amountMinor: Long, val tenderedMinor: Long?, val changeMinor: Long,
    val reference: String?, val state: PaymentState, val dueDate: String?)

/** What the seller is about to sell. [saleId] is a UUID-v4 made when the cart opens; it makes Complete sale safe to tap twice. */
data class CheckoutRequest(val saleId: String, val customerId: String?, val lines: List<CartLine>, val payment: PaymentInput)

enum class CheckoutProblem {
    TRIP_NOT_SELLING, NO_CUSTOMER, UNKNOWN_CUSTOMER, EMPTY_CART, TOO_MANY_LINES, DUPLICATE_PRODUCT,
    UNKNOWN_PRODUCT, BAD_QUANTITY, INSUFFICIENT_STOCK, UNPRICED, PRICE_NOT_EXACT, MIXED_CURRENCY,
    TOTAL_TOO_LARGE, CREDIT_TERMS_UNAVAILABLE, CASH_MISSING, CASH_SHORT, PRICES_CHANGED,
    UNKNOWN_PAYMENT_METHOD, REFERENCE_MISSING, REFERENCE_INVALID, REFERENCE_ALREADY_USED, CREDIT_LIMIT_EXCEEDED
}

/** A problem, optionally tied to a product line. */
data class CheckoutIssue(val problem: CheckoutProblem, val productId: String? = null)

data class QuotedLine(val lineNumber: Int, val product: Product, val quantityBase: Long, val unitPriceMinor: Long,
    val totalMinor: Long, val priceListIds: List<String>)

/** [tenderedMinor]/[changeMinor] are the cash handed over and change (non-cash: the amount and zero). */
data class CheckoutQuote(val lines: List<QuotedLine>, val currency: String, val totalMinor: Long,
    val tenderedMinor: Long, val changeMinor: Long, val payment: QuotedPayment)

/** [quote] is non-null only when there are no [issues]. */
data class CheckoutResult(val quote: CheckoutQuote?, val issues: List<CheckoutIssue>) {
    val ok: Boolean get() = quote != null && issues.isEmpty()
}

/**
 * Everything checkout is validated against, read from the scoped encrypted store. [serviceDate] dates credit;
 * [creditUsedMinor] is credit this phone sold per customer that the office has not acknowledged; [usedReferences]
 * are `method|REFERENCE` keys already recorded on this phone.
 */
data class CheckoutContext(val tripSelling: Boolean, val customers: List<Customer>, val products: List<Product>,
    val stock: List<TruckStock>, val prices: List<PriceLine>, val policy: VanPolicy?, val now: Long,
    val serviceDate: String? = null, val creditUsedMinor: Map<String,Long> = emptyMap(), val usedReferences: Set<String> = emptySet())

class CheckoutRefused(val issues: List<CheckoutIssue>) : IllegalStateException("Checkout refused")

object CheckoutRules {
    const val MAX_LINES = 100
    const val MAX_BASE = 999_999_999_999_999_999L
    /** ₱10 billion in centavos: far above any van sale, small enough that no sum can overflow. */
    const val MAX_MINOR = 1_000_000_000_000L
    private val uuidV4 = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")

    fun newSaleId(): String = UUID.randomUUID().toString()

    fun evaluate(request: CheckoutRequest, context: CheckoutContext): CheckoutResult {
        require(uuidV4.matches(request.saleId)) { "Sale ID must be a UUID-v4" }
        val issues = mutableListOf<CheckoutIssue>()
        if (!context.tripSelling || context.policy == null) issues += CheckoutIssue(CheckoutProblem.TRIP_NOT_SELLING)
        when {
            request.customerId.isNullOrBlank() -> issues += CheckoutIssue(CheckoutProblem.NO_CUSTOMER)
            context.customers.none { it.outletId == request.customerId } -> issues += CheckoutIssue(CheckoutProblem.UNKNOWN_CUSTOMER)
        }
        if (request.lines.isEmpty()) issues += CheckoutIssue(CheckoutProblem.EMPTY_CART)
        if (request.lines.size > MAX_LINES) issues += CheckoutIssue(CheckoutProblem.TOO_MANY_LINES)
        request.lines.groupBy { it.productId }.filterValues { it.size > 1 }.keys.forEach { issues += CheckoutIssue(CheckoutProblem.DUPLICATE_PRODUCT,it) }

        val products = context.products.associateBy { it.productId }
        val available = context.stock.associate { it.productId to it.availableBase }
        val quoted = mutableListOf<QuotedLine>()
        val currencies = mutableSetOf<String>()
        request.lines.forEachIndexed { index, line ->
            val product = products[line.productId]
            if (product == null) { issues += CheckoutIssue(CheckoutProblem.UNKNOWN_PRODUCT,line.productId); return@forEachIndexed }
            if (line.quantityBase !in 1L..MAX_BASE) { issues += CheckoutIssue(CheckoutProblem.BAD_QUANTITY,line.productId); return@forEachIndexed }
            // Only available stock sells; damaged stock never does. Negative stock only when the office allows it.
            if (!(context.policy?.allowNegativeStock ?: false) && (available[line.productId] ?: 0L) < line.quantityBase)
                issues += CheckoutIssue(CheckoutProblem.INSUFFICIENT_STOCK,line.productId)
            val matching = PriceResolver.matching(product,context.prices,context.now)
            val price = PriceResolver.resolve(product,context.prices,context.now)
            if (price == null) { issues += CheckoutIssue(CheckoutProblem.UNPRICED,line.productId); return@forEachIndexed }
            val total = lineTotal(price.unitPriceMinor,line.quantityBase,product.quantityScale)
            if (total == null) { issues += CheckoutIssue(CheckoutProblem.PRICE_NOT_EXACT,line.productId); return@forEachIndexed }
            if (total > MAX_MINOR) { issues += CheckoutIssue(CheckoutProblem.TOTAL_TOO_LARGE,line.productId); return@forEachIndexed }
            currencies += price.currency
            quoted += QuotedLine(index+1,product,line.quantityBase,price.unitPriceMinor,total,matching.map { it.priceListId }.distinct().sorted())
        }
        if (currencies.size > 1) issues += CheckoutIssue(CheckoutProblem.MIXED_CURRENCY)
        val total = quoted.fold(0L) { sum, line -> Math.addExact(sum,line.totalMinor) }
        if (total > MAX_MINOR) issues += CheckoutIssue(CheckoutProblem.TOTAL_TOO_LARGE)

        val customer = context.customers.firstOrNull { it.outletId == request.customerId }
        val payment = payment(request.payment,total,customer,context,issues)
        if (issues.isNotEmpty() || payment == null) return CheckoutResult(null,issues.distinct())
        return CheckoutResult(CheckoutQuote(quoted,currencies.single(),total,payment.tenderedMinor ?: total,payment.changeMinor,payment),emptyList())
    }

    /** VAN-012 payment rules; adds problems to [issues] and returns null when the payment cannot be recorded. */
    private fun payment(input: PaymentInput, total: Long, customer: Customer?, context: CheckoutContext, issues: MutableList<CheckoutIssue>): QuotedPayment? {
        val method = (context.policy?.paymentMethods ?: PaymentMethod.CASH_ONLY).firstOrNull { it.code == input.methodCode }
            ?: return null.also { issues += CheckoutIssue(CheckoutProblem.UNKNOWN_PAYMENT_METHOD) }
        return when (method.kind) {
            PaymentKind.CASH -> {
                val cash = input.tenderedMinor
                when {
                    cash == null || cash < 0 || cash > MAX_MINOR -> null.also { issues += CheckoutIssue(CheckoutProblem.CASH_MISSING) }
                    cash < total -> null.also { issues += CheckoutIssue(CheckoutProblem.CASH_SHORT) }
                    else -> QuotedPayment(method,total,cash,cash - total,null,PaymentState.PAID,null)
                }
            }
            // Check, e-wallet or bank: exactly the total (no change); the office confirms the reference later.
            PaymentKind.OTHER -> {
                val reference = if (!method.referenceRequired) null else {
                    val normalized = PaymentReference.normalize(input.reference)
                    when {
                        input.reference.isNullOrBlank() -> return null.also { issues += CheckoutIssue(CheckoutProblem.REFERENCE_MISSING) }
                        normalized == null -> return null.also { issues += CheckoutIssue(CheckoutProblem.REFERENCE_INVALID) }
                        PaymentReference.key(method.code,normalized) in context.usedReferences ->
                            return null.also { issues += CheckoutIssue(CheckoutProblem.REFERENCE_ALREADY_USED) }
                        else -> normalized
                    }
                }
                QuotedPayment(method,total,null,0,reference,PaymentState.AWAITING_CONFIRMATION,null)
            }
            // Credit: only for a customer with office terms, within the credit still available on this phone.
            PaymentKind.CREDIT -> {
                val credit = customer?.credit?.takeIf { !customer.localOnly }
                    ?: return null.also { issues += CheckoutIssue(CheckoutProblem.CREDIT_TERMS_UNAVAILABLE) }
                val used = context.creditUsedMinor[customer.outletId] ?: 0L
                if (Math.addExact(used,total) > credit.availableMinor) return null.also { issues += CheckoutIssue(CheckoutProblem.CREDIT_LIMIT_EXCEEDED) }
                val due = context.serviceDate?.let { runCatching { java.time.LocalDate.parse(it).plusDays(credit.termsDays.toLong()).toString() }.getOrNull() }
                QuotedPayment(method,total,null,0,null,PaymentState.ON_ACCOUNT,due)
            }
        }
    }

    /** The cart's lines and total alone, whatever payment the seller picks next (shown before the payment is entered). */
    fun cartQuote(request: CheckoutRequest, context: CheckoutContext): CheckoutQuote? =
        evaluate(request.copy(payment = PaymentInput(PaymentMethod.CASH.code,MAX_MINOR)),
            context.copy(policy = context.policy?.copy(paymentMethods = PaymentMethod.CASH_ONLY))).quote

    /** Credit the customer can still take on this phone (office-available minus unacknowledged credit sold here); null without terms. */
    fun creditLeft(customer: Customer, context: CheckoutContext): Long? = customer.credit?.takeIf { !customer.localOnly }?.let {
        maxOf(0L,it.availableMinor - (context.creditUsedMinor[customer.outletId] ?: 0L))
    }

    /**
     * Unit price is per one product UOM; [quantityBase] counts base units of which [quantityScale] make one UOM.
     * Null when the line total is not a whole number of centavos (the handheld never rounds money).
     */
    fun lineTotal(unitPriceMinor: Long, quantityBase: Long, quantityScale: Long): Long? {
        if (unitPriceMinor < 0 || quantityBase <= 0 || quantityScale <= 0) return null
        val (q, r) = BigInteger.valueOf(unitPriceMinor).multiply(BigInteger.valueOf(quantityBase)).divideAndRemainder(BigInteger.valueOf(quantityScale))
        return if (r.signum() != 0 || q.bitLength() > 62) null else q.toLong()
    }
}

/** VAN-012 reference numbers: trimmed, single-spaced, upper case; letters, digits, space, `-`, `/`, `.`; 1–40 characters. */
object PaymentReference {
    private val allowed = Regex("^[A-Z0-9][A-Z0-9 ./-]{0,39}$")
    fun normalize(text: String?): String? {
        val value = text?.trim()?.replace(Regex("\\s+")," ")?.uppercase() ?: return null
        return value.takeIf { allowed.matches(it) }
    }
    fun key(methodCode: String, normalized: String) = "$methodCode|$normalized"
}
