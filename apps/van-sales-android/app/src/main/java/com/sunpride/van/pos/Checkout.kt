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

/**
 * One cart line: a product and a quantity in base units (integral, never a float). There is intentionally no price here:
 * prices come only from the bootstrap, and the store re-evaluates them inside its transaction before saving; a changed agreed total
 * is refused as [CheckoutProblem.PRICES_CHANGED]. */
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
data class CheckoutRequest(val saleId: String, val customerId: String?, val lines: List<CartLine>, val payment: PaymentInput,
    val manualDiscount:ManualDiscountInput? = null,val priceOverride:SalePriceOverride?=null,val creditOverride:FinancialOverride?=null,
    /** IP-HH2: Senior / PWD / Solo parent / Athlete / Uniformed claim; worked out by [com.sunpride.van.selling.Privilege], never together with a manual discount. */
    val claim: com.sunpride.van.selling.DiscountClaim? = null,
    /** IP-HH2: the second tender of a split sale (cash stays in [payment]); the rest of the total is paid with it. */
    val split: SplitPayment? = null)

enum class CheckoutProblem {
    TRIP_NOT_SELLING, NO_CUSTOMER, UNKNOWN_CUSTOMER, EMPTY_CART, TOO_MANY_LINES, DUPLICATE_PRODUCT,
    UNKNOWN_PRODUCT, BAD_QUANTITY, INSUFFICIENT_STOCK, UNPRICED, PRICE_NOT_EXACT, MIXED_CURRENCY,
    TOTAL_TOO_LARGE, CREDIT_TERMS_UNAVAILABLE, CASH_MISSING, CASH_SHORT, PRICES_CHANGED,
    UNKNOWN_PAYMENT_METHOD, REFERENCE_MISSING, REFERENCE_INVALID, REFERENCE_ALREADY_USED, CREDIT_LIMIT_EXCEEDED,
    PROMOTION_CONFLICT, PROMOTION_NEEDS_OFFICE,
    DISCOUNT_INVALID,DISCOUNT_REASON_REQUIRED,DISCOUNT_POLICY_NOT_READY,DISCOUNT_APPROVAL_REQUIRED,DISCOUNT_APPROVAL_INVALID,
    TAX_NOT_READY, CREDIT_EXPOSURE_STALE, CREDIT_EXPOSURE_UNKNOWN,
    OVERRIDE_REASON_REQUIRED,OVERRIDE_POLICY_NOT_READY,OVERRIDE_APPROVAL_REQUIRED,OVERRIDE_INVALID,
    /** VAN-022: the trip's cash is already counted, so it sells nothing more. */
    CASH_COUNTED,
    /** VAN-023: the approved physical stock count freezes every stock-changing action. */
    STOCK_COUNTED,
    /** IP-HH2 discount claim: missing ID or name, used with a manual discount, or an item with no tax set-up on this phone. */
    DISCOUNT_CLAIM_INVALID, DISCOUNT_CLAIM_WITH_MANUAL, DISCOUNT_TAX_UNKNOWN,
    /** SP-0169: the office has Senior/PWD discounts switched off for this route; the sale would be refused and its number spoiled. */
    DISCOUNT_SWITCHED_OFF,
    /** IP-HH2 split tender: the parts do not add up, a part is missing, or the method cannot be split. */
    SPLIT_INVALID
}

/** A problem, optionally tied to a product line. */
data class CheckoutIssue(val problem: CheckoutProblem, val productId: String? = null)

/**
 * A quote is the only source of a sale price. [quantityBase] is the total stock deduction; [paidBase] and [freeBase]
 * explain it. The cart deliberately has no price field: the store re-evaluates this quote in its transaction and
 * refuses with PRICES_CHANGED when the agreed total no longer matches.
 */
data class QuotedLine(val lineNumber: Int, val product: Product, val quantityBase: Long, val unitPriceMinor: Long,
    val totalMinor: Long, val priceListIds: List<String>, val paidBase: Long = quantityBase, val freeBase: Long = 0L,
    val grossMinor: Long = totalMinor, val discountMinor: Long = 0L, val priceListId: String? = null,
    val priceListCode: String? = null, val promotion: QuotedPromotion? = null,val manualDiscountMinor:Long = 0L,
    /** IP-HH2: what the statutory discount did to this line ([totalMinor] is then the amount payable). */
    val privilegeDiscountMinor: Long = 0L, val vatRemovedMinor: Long = 0L, val privilegeType: com.sunpride.van.selling.PrivilegeType? = null,
    val legal: com.sunpride.van.selling.LegalLine? = null)

/** [tenderedMinor]/[changeMinor] are the cash handed over and change (non-cash: the amount and zero). */
data class CheckoutQuote(val lines: List<QuotedLine>, val currency: String, val totalMinor: Long,
    val tenderedMinor: Long, val changeMinor: Long, val payment: QuotedPayment, val earnedMinor: Long = 0,
    /** IP-HH2: the discount claim's totals (null without a claim). */
    val legal: com.sunpride.van.selling.LegalCart? = null, val claim: com.sunpride.van.selling.DiscountClaim? = null,
    /** IP-HH2: the cash/other split when the sale is paid with two tenders. */
    val split: QuotedSplit? = null)

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
    val serviceDate: String? = null, val creditUsedMinor: Map<String,Long> = emptyMap(), val usedReferences: Set<String> = emptySet(),
    val cashCounted: Boolean = false, val promotions: List<com.sunpride.van.data.Promotion> = emptyList(),
    val stockCounted: Boolean = false,val previewOnly:Boolean = false,val governedPromotionsJson:String? = null,
    /** IP-HH2: how each product is taxed on this phone; null = unknown, so a discount claim is refused rather than guessed. */
    val taxFacts: ((QuotedLine, String?) -> com.sunpride.van.selling.TaxFact?)? = null,
    /** IP-SCPWD-CAP: what is left of a senior/PWD card's weekly limit as this phone knows it; null = no limit known (the sale then carries no limit). */
    val capRemaining: ((com.sunpride.van.selling.DiscountClaim) -> Long?)? = null)

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
        if (context.cashCounted) issues += CheckoutIssue(CheckoutProblem.CASH_COUNTED)
        if (context.stockCounted) issues += CheckoutIssue(CheckoutProblem.STOCK_COUNTED)
        when {
            request.customerId.isNullOrBlank() -> issues += CheckoutIssue(CheckoutProblem.NO_CUSTOMER)
            context.customers.none { it.outletId == request.customerId } -> issues += CheckoutIssue(CheckoutProblem.UNKNOWN_CUSTOMER)
        }
        if (request.lines.isEmpty()) issues += CheckoutIssue(CheckoutProblem.EMPTY_CART)
        if (request.lines.size > MAX_LINES) issues += CheckoutIssue(CheckoutProblem.TOO_MANY_LINES)
        request.lines.groupBy { it.productId }.filterValues { it.size > 1 }.keys.forEach { issues += CheckoutIssue(CheckoutProblem.DUPLICATE_PRODUCT,it) }

        val products = context.products.associateBy { it.productId }
        val available = context.stock.associate { it.productId to it.availableBase }
        val customer = context.customers.firstOrNull { it.outletId == request.customerId }
        val effectivePrices=runCatching{SaleAdjustments.prices(request,context)}.getOrElse{issues+=CheckoutIssue(CheckoutProblem.OVERRIDE_INVALID);context.prices}
        val promotionResult = customer?.let { customer ->
            if(context.governedPromotionsJson!=null) PromotionEngine.applyGoverned(request.lines,customer,products,effectivePrices,context.governedPromotionsJson,context.now)
            else if(PromotionEngine.useCanonical(request,context)) CanonicalPromotions.apply(request.lines,customer,products,effectivePrices,org.json.JSONObject(checkNotNull(context.policy?.schemesJson)),context.now)
            else PromotionEngine.apply(request.lines,customer,products,effectivePrices,context.promotions,context.now)
        }
            ?: PromotionResult(emptyList(),emptyList())
        issues += promotionResult.issues
        val needsOfficeProducts = promotionResult.issues.filter { it.problem == CheckoutProblem.PROMOTION_NEEDS_OFFICE }
            .mapNotNull { it.productId }.toSet()
        val quoted = mutableListOf<QuotedLine>()
        val currencies = mutableSetOf<String>()
        request.lines.forEachIndexed { index, line ->
            val product = products[line.productId]
            if (product == null) { issues += CheckoutIssue(CheckoutProblem.UNKNOWN_PRODUCT,line.productId); return@forEachIndexed }
            if (line.quantityBase !in 1L..MAX_BASE) { issues += CheckoutIssue(CheckoutProblem.BAD_QUANTITY,line.productId); return@forEachIndexed }
            val promotionLine = promotionResult.lines.firstOrNull { it.lineNumber == index + 1 }
            val price = promotionLine?.price ?: PriceResolver.resolve(product,effectivePrices,context.now,customer)
            if (price == null && line.productId !in needsOfficeProducts) {
                issues += CheckoutIssue(CheckoutProblem.UNPRICED,line.productId); return@forEachIndexed
            }
            if (context.governedPromotionsJson==null && price != null && lineTotal(price.unitPriceMinor,line.quantityBase,product.quantityScale) == null)
                issues += CheckoutIssue(CheckoutProblem.PRICE_NOT_EXACT,line.productId)
        }
        promotionResult.lines.forEach { line ->
            val price = line.price
            if (line.paidBase > 0L && price == null) return@forEach
            val gross = if(context.governedPromotionsJson!=null) line.grossMinor else if (line.paidBase == 0L) 0L else lineTotal(checkNotNull(price).unitPriceMinor,line.paidBase,line.product.quantityScale)
            if (gross == null) { issues += CheckoutIssue(CheckoutProblem.PRICE_NOT_EXACT,line.product.productId); return@forEach }
            val discount = minOf(line.discountMinor,gross)
            val total = Math.subtractExact(gross,discount)
            if (total > MAX_MINOR) { issues += CheckoutIssue(CheckoutProblem.TOTAL_TOO_LARGE,line.product.productId); return@forEach }
            if (price != null) currencies += price.currency
            val matching = PriceResolver.matching(line.product,effectivePrices,context.now,customer)
            val quantity = Math.addExact(line.paidBase,line.freeBase)
            // Stock is checked against paid plus free goods; damaged stock is never sellable.
            if (!(context.policy?.allowNegativeStock ?: false) && (available[line.product.productId] ?: 0L) < quantity)
                issues += CheckoutIssue(CheckoutProblem.INSUFFICIENT_STOCK,line.product.productId)
            quoted += QuotedLine(line.lineNumber,line.product,quantity,price?.unitPriceMinor ?: 0L,total,
                matching.map { it.priceListId }.distinct().sorted(),line.paidBase,line.freeBase,gross,discount,
                price?.priceListId,price?.priceListCode,line.promotion)
        }
        runCatching { ManualDiscounts.apply(quoted,request.manualDiscount) }.onSuccess { adjusted->quoted.clear();quoted.addAll(adjusted) }
            .onFailure { issues+=CheckoutIssue(CheckoutProblem.DISCOUNT_INVALID) }
        if(!runCatching{ManualDiscounts.amount(quoted)<=MAX_MINOR}.getOrDefault(false))issues+=CheckoutIssue(CheckoutProblem.TOTAL_TOO_LARGE)
        if(!context.previewOnly&&context.governedPromotionsJson==null&&!PromotionEngine.useCanonical(request,context))ManualDiscounts.authorize(request,quoted,context)?.let{issues+=CheckoutIssue(it)}
        if(!context.previewOnly&&request.priceOverride?.unitMinor?.isNotEmpty()==true)SaleAdjustments.authorize("price",request,quoted,context)?.let{issues+=CheckoutIssue(it)}
        if(!context.previewOnly&&context.governedPromotionsJson==null&&!PromotionEngine.useCanonical(request,context)&&PromotionEngine.needsOffice(request,context))issues+=CheckoutIssue(CheckoutProblem.PROMOTION_NEEDS_OFFICE)
        if(!context.previewOnly&&context.governedPromotionsJson==null&&context.policy?.fiscalJson!=null)runCatching{
            com.sunpride.van.fiscal.FiscalTax.snapshot(quoted,org.json.JSONObject(context.policy.fiscalJson),customer?.priceListId,context.now)
        }.onFailure{issues+=CheckoutIssue(CheckoutProblem.TAX_NOT_READY)}
        if(context.governedPromotionsJson!=null && context.policy?.allowNegativeStock!=true) {
            quoted.groupBy {it.product.productId}.forEach {(id,lines)->
                val required=lines.fold(BigInteger.ZERO){n,l->n+BigInteger.valueOf(l.quantityBase)}
                if(required>BigInteger.valueOf(available[id]?:0L))issues+=CheckoutIssue(CheckoutProblem.INSUFFICIENT_STOCK,id)
            }
        }
        val legalCart = applyClaim(request,context,customer,quoted,issues)
        if (currencies.size > 1) issues += CheckoutIssue(CheckoutProblem.MIXED_CURRENCY)
        val total = runCatching { quoted.fold(0L) { sum, line -> Math.addExact(sum,line.totalMinor) } }.getOrElse {
            issues += CheckoutIssue(CheckoutProblem.TOTAL_TOO_LARGE); 0L
        }
        if (total > MAX_MINOR) issues += CheckoutIssue(CheckoutProblem.TOTAL_TOO_LARGE)

        // IP-HH2: an item that left the cart no longer counts as eligible (the server refuses a claim naming an item that is not in the sale).
        val prunedClaim = request.claim?.let { c -> c.copy(eligibleProductIds = c.eligibleProductIds?.intersect(quoted.map { it.product.productId }.toSet()),capBudget = legalCart?.budget) }
        val split = request.split
        if (split != null) {
            // IP-HH2: cash plus one more tender. The other tender pays [split.amountMinor]; cash pays the rest and only cash gives change.
            val methods = context.policy?.paymentMethods ?: PaymentMethod.CASH_ONLY
            val cashMethod = methods.firstOrNull { it.code == request.payment.methodCode }
            val otherMethod = methods.firstOrNull { it.code == split.methodCode }
            if (cashMethod?.kind != PaymentKind.CASH || otherMethod == null || otherMethod.kind == PaymentKind.CASH || !SplitTenders.partsValid(total,split.amountMinor)) issues += CheckoutIssue(CheckoutProblem.SPLIT_INVALID)
            else {
                val otherPay = payment(PaymentInput(split.methodCode,null,split.reference),split.amountMinor,customer,context,issues,request,quoted)
                val cashPay = payment(request.payment,total - split.amountMinor,customer,context,issues,request,quoted)
                if (issues.isEmpty() && otherPay != null && cashPay != null)
                    return CheckoutResult(CheckoutQuote(quoted,currencies.single(),total,cashPay.tenderedMinor ?: cashPay.amountMinor,cashPay.changeMinor,cashPay,promotionResult.earnedMinor,legalCart,prunedClaim,QuotedSplit(cashPay,otherPay)),emptyList())
            }
            return CheckoutResult(null,issues.distinct())
        }
        val payment = payment(request.payment,total,customer,context,issues,request,quoted)
        if (issues.isNotEmpty() || payment == null) return CheckoutResult(null,issues.distinct())
        return CheckoutResult(CheckoutQuote(quoted,currencies.single(),total,payment.tenderedMinor ?: total,payment.changeMinor,payment,promotionResult.earnedMinor,legalCart,prunedClaim),emptyList())
    }

    /**
     * IP-HH2: apply the statutory discount claim to the quoted lines (replaces each line's total with the amount payable). Returns the
     * claim's totals, or null when there is no claim or it is refused (the reason is added to [issues]).
     */
    private fun applyClaim(request: CheckoutRequest, context: CheckoutContext, customer: Customer?, quoted: MutableList<QuotedLine>, issues: MutableList<CheckoutIssue>): com.sunpride.van.selling.LegalCart? {
        val claim = request.claim ?: return null
        if (!com.sunpride.van.selling.PrivilegeSwitch.offered(context.policy)) { issues += CheckoutIssue(CheckoutProblem.DISCOUNT_SWITCHED_OFF); return null }
        if (com.sunpride.van.selling.ClaimRules.problem(claim) != null) { issues += CheckoutIssue(CheckoutProblem.DISCOUNT_CLAIM_INVALID); return null }
        if (quoted.any { it.manualDiscountMinor > 0L } || request.manualDiscount?.lineMinor?.isNotEmpty() == true || request.manualDiscount?.basketMinor?.let { it > 0L } == true || request.priceOverride?.unitMinor?.isNotEmpty() == true) {
            issues += CheckoutIssue(CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL); return null
        }
        val facts = context.taxFacts
        val inputs = quoted.map { q -> com.sunpride.van.selling.LegalInput(q.product.productId,q.grossMinor,q.discountMinor,facts?.invoke(q,customer?.priceListId)) }
        val cart = com.sunpride.van.selling.Privilege.cart(inputs,claim,context.capRemaining?.invoke(claim)).getOrElse {
            inputs.filter { it.gross > 0 && it.tax?.known != true }.forEach { issues += CheckoutIssue(CheckoutProblem.DISCOUNT_TAX_UNKNOWN,it.productId) }
            if (issues.none { it.problem == CheckoutProblem.DISCOUNT_TAX_UNKNOWN }) issues += CheckoutIssue(CheckoutProblem.DISCOUNT_TAX_UNKNOWN)
            return null
        }
        quoted.indices.forEach { i ->
            val r = cart.lines[i]
            quoted[i] = quoted[i].copy(totalMinor = r.net,privilegeDiscountMinor = r.privilegeDiscount,vatRemovedMinor = r.vatRemoved,privilegeType = r.privilegeType,legal = r)
        }
        return cart
    }

    /** VAN-012 payment rules; adds problems to [issues] and returns null when the payment cannot be recorded. */
    private fun payment(input: PaymentInput, total: Long, customer: Customer?, context: CheckoutContext, issues: MutableList<CheckoutIssue>,request:CheckoutRequest,lines:List<QuotedLine>): QuotedPayment? {
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
                        normalized == null || method.code == "card" && normalized.count { it.isDigit() } >= 12 -> return null.also { issues += CheckoutIssue(CheckoutProblem.REFERENCE_INVALID) }
                        PaymentReference.key(method.code,normalized) in context.usedReferences ->
                            return null.also { issues += CheckoutIssue(CheckoutProblem.REFERENCE_ALREADY_USED) }
                        else -> normalized
                    }
                }
                QuotedPayment(method,total,null,0,reference,PaymentState.AWAITING_CONFIRMATION,null)
            }
            // Credit: only for a customer with office terms, within the credit still available on this phone.
            PaymentKind.CREDIT -> {
                val buyer=customer?:return null.also { issues+=CheckoutIssue(CheckoutProblem.CREDIT_TERMS_UNAVAILABLE) }
                val credit=SapCreditExceptions.credit(request,context,total)?:CreditExposure.credit(buyer,context)
                    ?:return null.also { issues+=CheckoutIssue(CreditExposure.problem(buyer,context)) }
                val used = context.creditUsedMinor[buyer.outletId] ?: 0L
                if(request.creditOverride!=null)SaleAdjustments.authorize("credit",request,lines,context)?.let{problem->return null.also{issues+=CheckoutIssue(problem)}}
                if (Math.addExact(used,total) > credit.availableMinor && (request.creditOverride==null||!SaleAdjustments.creditWithinSap(request,lines,context,Math.addExact(used,total)))) return null.also { issues += CheckoutIssue(CheckoutProblem.CREDIT_LIMIT_EXCEEDED) }
                val due = context.serviceDate?.let { runCatching { java.time.LocalDate.parse(it).plusDays(credit.termsDays.toLong()).toString() }.getOrNull() }
                QuotedPayment(method,total,null,0,null,PaymentState.ON_ACCOUNT,due)
            }
        }
    }

    /** The cart's lines and total alone, whatever payment the seller picks next (shown before the payment is entered). */
    fun cartQuote(request: CheckoutRequest, context: CheckoutContext): CheckoutQuote? =
        evaluate(request.copy(payment = PaymentInput(PaymentMethod.CASH.code,MAX_MINOR),split = null),
            context.copy(policy = context.policy?.copy(paymentMethods = PaymentMethod.CASH_ONLY),previewOnly=true)).quote

    /** Credit the customer can still take on this phone (office-available minus unacknowledged credit sold here); null without terms. */
    fun creditLeft(customer: Customer, context: CheckoutContext): Long? = CreditExposure.credit(customer,context)?.let {
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
