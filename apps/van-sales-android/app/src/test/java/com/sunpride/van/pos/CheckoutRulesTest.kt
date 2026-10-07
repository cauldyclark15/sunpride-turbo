package com.sunpride.van.pos

import com.sunpride.van.data.*
import com.sunpride.van.ui.VanRules
import org.junit.Assert.*
import org.junit.Test

class CheckoutRulesTest {
    private val now = 1_791_338_400_000L
    private val juice = Product("p1","SP-PJ-1L","Pineapple Juice 1L","PC",1,emptyList())
    private val chunks = Product("p2","SP-PC-432","Pineapple Chunks 432g","PC",1,emptyList())
    /** Sold by the kilogram, stored in grams. */
    private val bulk = Product("p3","SP-BULK","Dried Pineapple","KG",1000,emptyList())
    private val route = Customer("o1","O-1001","Aling Nena Store",null,1,"route")
    private val onTerms = Customer("o2","O-1002","JM Sari-Sari",null,2,"route",credit = CustomerCredit(30,50_000))
    private val walkIn = Customer("local:w1","","Corner Store",null,null,"walk_in","Not on list",true)
    private val check = PaymentMethod("check","Check",PaymentKind.OTHER,true,"Check number")
    private val gcash = PaymentMethod("gcash","GCash",PaymentKind.OTHER,true,"GCash reference number")
    private val voucher = PaymentMethod("voucher","Promo voucher",PaymentKind.OTHER,false,null)
    private val creditMethod = PaymentMethod("credit","Credit (charge to account)",PaymentKind.CREDIT,false,null)
    private val methods = listOf(PaymentMethod.CASH,check,gcash,voucher,creditMethod)
    private val policy = VanPolicy(walkInAllowed = true,paymentMethods = methods)
    private val saleId = "6f1c1f3e-2b7a-4c55-9d1e-0c4b8f7a1a01"
    private fun price(product: String, minor: Long, uom: String = "PC", list: String = "L1", currency: String = "PHP", from: Long = now-1, to: Long? = null) =
        PriceLine(list,product,uom,minor,currency,from,to)
    private val prices = listOf(price("p1",8_500),price("p3",32_000,"KG"))
    private fun context(stock: List<TruckStock> = listOf(TruckStock("p1",10,2),TruckStock("p2",5,0),TruckStock("p3",2_000,0)),
        prices: List<PriceLine> = this.prices, policy: VanPolicy? = this.policy, selling: Boolean = true,
        creditUsed: Map<String,Long> = emptyMap(), usedReferences: Set<String> = emptySet(), customers: List<Customer> = listOf(route,walkIn,onTerms),
        promotions: List<Promotion> = emptyList()) =
        CheckoutContext(selling,customers,listOf(juice,chunks,bulk),stock,prices,policy,now,"2026-10-07",creditUsed,usedReferences,false,promotions)
    private fun request(vararg lines: CartLine, customer: String? = "o1", payment: PaymentInput = PaymentInput("cash",1_000_000)) =
        CheckoutRequest(saleId,customer,lines.toList(),payment)
    private fun problems(result: CheckoutResult) = result.issues.map { it.problem }.toSet()

    @Test fun pricedCashSaleTotalsInCentavosAndGivesChange() {
        val result = CheckoutRules.evaluate(request(CartLine("p1",3),CartLine("p3",1_500),payment = PaymentInput("cash",80_000)),context())
        assertTrue(result.issues.toString(),result.ok)
        val quote = result.quote!!
        assertEquals(listOf(25_500L,48_000L),quote.lines.map { it.totalMinor })
        assertEquals(listOf(1,2),quote.lines.map { it.lineNumber })
        assertEquals(73_500L,quote.totalMinor); assertEquals(6_500L,quote.changeMinor); assertEquals("PHP",quote.currency)
        assertEquals(listOf("L1"),quote.lines.first().priceListIds)
    }
    @Test fun exactCashAndWalkInCustomerAreAccepted() {
        val result = CheckoutRules.evaluate(request(CartLine("p1",2),customer = "local:w1",payment = PaymentInput("cash",17_000)),context())
        assertTrue(result.ok); assertEquals(0L,result.quote!!.changeMinor)
    }
    @Test fun unpricedProductBlocksTheSaleInsteadOfGuessing() {
        val result = CheckoutRules.evaluate(request(CartLine("p1",1),CartLine("p2",1)),context())
        assertNull(result.quote)
        assertEquals(listOf(CheckoutIssue(CheckoutProblem.UNPRICED,"p2")),result.issues)
        // Two lists disagreeing on a price is not a price either; a future or expired line never prices.
        val conflicting = prices + price("p1",9_000,list = "L2")
        assertTrue(CheckoutProblem.UNPRICED in problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(prices = conflicting))))
        assertTrue(CheckoutProblem.UNPRICED in problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(prices = listOf(price("p1",8_500,from = now+1))))))
        assertTrue(CheckoutProblem.UNPRICED in problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(prices = listOf(price("p1",8_500,to = now))))))
        // Agreeing lists price the line and are all recorded as the source.
        val agreeing = CheckoutRules.evaluate(request(CartLine("p1",1)),context(prices = prices + price("p1",8_500,list = "L0")))
        assertEquals(listOf("L0","L1"),agreeing.quote!!.lines.single().priceListIds)
    }
    @Test fun stockIsCheckedAgainstAvailableNeverDamaged() {
        val result = CheckoutRules.evaluate(request(CartLine("p1",11)),context())
        assertEquals(listOf(CheckoutIssue(CheckoutProblem.INSUFFICIENT_STOCK,"p1")),result.issues)
        assertTrue(CheckoutRules.evaluate(request(CartLine("p1",10)),context()).ok)
        assertTrue("office policy may allow negative stock",CheckoutRules.evaluate(request(CartLine("p1",11)),context(policy = policy.copy(allowNegativeStock = true))).ok)
        assertTrue(CheckoutProblem.INSUFFICIENT_STOCK in problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(stock = emptyList()))))
    }
    @Test fun customerMustBeChosenAndOnThisPhone() {
        assertEquals(setOf(CheckoutProblem.NO_CUSTOMER),problems(CheckoutRules.evaluate(request(CartLine("p1",1),customer = null),context())))
        assertEquals(setOf(CheckoutProblem.UNKNOWN_CUSTOMER),problems(CheckoutRules.evaluate(request(CartLine("p1",1),customer = "o-gone"),context())))
    }
    @Test fun tripMustBeSellingAndPolicyBootstrapped() {
        assertEquals(setOf(CheckoutProblem.TRIP_NOT_SELLING),problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(selling = false))))
        assertTrue(CheckoutProblem.TRIP_NOT_SELLING in problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(policy = null))))
    }
    @Test fun cartShapeIsValidated() {
        assertEquals(setOf(CheckoutProblem.EMPTY_CART),problems(CheckoutRules.evaluate(request(),context())))
        assertTrue(CheckoutProblem.DUPLICATE_PRODUCT in problems(CheckoutRules.evaluate(request(CartLine("p1",1),CartLine("p1",2)),context())))
        assertEquals(setOf(CheckoutProblem.BAD_QUANTITY),problems(CheckoutRules.evaluate(request(CartLine("p1",0)),context())))
        assertEquals(setOf(CheckoutProblem.BAD_QUANTITY),problems(CheckoutRules.evaluate(request(CartLine("p1",-2)),context())))
        assertEquals(setOf(CheckoutProblem.UNKNOWN_PRODUCT),problems(CheckoutRules.evaluate(request(CartLine("p9",1)),context())))
        val many = (1..101).map { CartLine("p$it",1) }.toTypedArray()
        assertTrue(CheckoutProblem.TOO_MANY_LINES in problems(CheckoutRules.evaluate(request(*many),context())))
    }
    @Test fun cashIsEnforced() {
        assertEquals(setOf(CheckoutProblem.CASH_MISSING),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("cash",null)),context())))
        assertEquals(setOf(CheckoutProblem.CASH_MISSING),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("cash",-1)),context())))
        assertEquals(setOf(CheckoutProblem.CASH_SHORT),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("cash",8_499)),context())))
    }
    @Test fun moneyIsNeverRoundedOrOverflowed() {
        // 1 gram of a ₱320.00/kg product is 32 centavos exactly; 1 gram at ₱320.01/kg is not a whole centavo.
        assertEquals(32L,CheckoutRules.lineTotal(32_000,1,1000))
        assertNull(CheckoutRules.lineTotal(32_001,1,1000))
        assertNull(CheckoutRules.lineTotal(Long.MAX_VALUE,Long.MAX_VALUE,1))
        assertEquals(setOf(CheckoutProblem.PRICE_NOT_EXACT),problems(CheckoutRules.evaluate(request(CartLine("p3",1)),context(prices = listOf(price("p3",32_001,"KG"))))))
        assertTrue(CheckoutProblem.TOTAL_TOO_LARGE in problems(CheckoutRules.evaluate(request(CartLine("p1",10)),
            context(prices = listOf(price("p1",CheckoutRules.MAX_MINOR)),policy = policy.copy(allowNegativeStock = true)))))
        assertEquals(setOf(CheckoutProblem.MIXED_CURRENCY),problems(CheckoutRules.evaluate(request(CartLine("p1",1),CartLine("p3",1_000)),
            context(prices = listOf(price("p1",8_500),price("p3",100,"KG",currency = "USD"))))))
    }
    @Test fun saleIdMustBeAUuidV4() {
        assertTrue(runCatching { CheckoutRules.evaluate(CheckoutRequest("not-a-uuid","o1",listOf(CartLine("p1",1)),PaymentInput("cash",10_000)),context()) }.isFailure)
        assertEquals(4,java.util.UUID.fromString(CheckoutRules.newSaleId()).version())
    }
    @Test fun everyProblemHasPlainWordsAndCashParsesToCentavos() {
        CheckoutProblem.entries.forEach { assertTrue(VanRules.checkoutMessage(it,"Juice").isNotBlank()) }
        assertFalse(VanRules.checkoutMessage(CheckoutProblem.UNPRICED,"Juice").contains("UNPRICED"))
        assertEquals(25_050L,VanRules.parseMoney("250.50")); assertEquals(100_000L,VanRules.parseMoney("₱1,000"))
        assertNull(VanRules.parseMoney("1.005")); assertNull(VanRules.parseMoney("-1")); assertNull(VanRules.parseMoney("abc")); assertNull(VanRules.parseMoney(""))
        assertTrue(VanRules.canSell(Trip("t","T","active","2026-10-07",null,null,null,null,"l",null,null)))
        assertTrue(VanRules.canSell(Trip("t","T","loaded","2026-10-07",null,null,null,null,"l",null,null,startPending = true)))
        assertFalse(VanRules.canSell(Trip("t","T","loaded","2026-10-07",null,null,null,null,"l",null,null)))
    }

    // ── VAN-012 payment methods ──
    @Test fun cashPaymentIsPaidWithChangeAndNoReference() {
        val pay = CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("cash",10_000,"IGNORED")),context()).quote!!.payment
        assertEquals(PaymentState.PAID,pay.state); assertEquals(1_500L,pay.changeMinor); assertEquals(10_000L,pay.tenderedMinor)
        assertNull(pay.reference); assertNull(pay.dueDate); assertEquals(8_500L,pay.amountMinor)
    }
    @Test fun otherMethodsTakeTheExactTotalAndNeedAValidUnusedReference() {
        val quote = CheckoutRules.evaluate(request(CartLine("p1",2),payment = PaymentInput("check",null,"  bdo  000123 ")),context()).quote!!
        assertEquals("check",quote.payment.method.code); assertEquals(PaymentState.AWAITING_CONFIRMATION,quote.payment.state)
        assertEquals("BDO 000123",quote.payment.reference); assertEquals(17_000L,quote.payment.amountMinor)
        assertEquals(0L,quote.changeMinor); assertEquals(17_000L,quote.tenderedMinor); assertNull(quote.payment.tenderedMinor)
        assertEquals(setOf(CheckoutProblem.REFERENCE_MISSING),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("gcash",null,"  ")),context())))
        assertEquals(setOf(CheckoutProblem.REFERENCE_INVALID),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("gcash",null,"ref#1")),context())))
        assertEquals(setOf(CheckoutProblem.REFERENCE_INVALID),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("gcash",null,"9".repeat(41))),context())))
        // The same check number cannot pay twice; the same digits under another method are a different reference.
        val used = setOf(PaymentReference.key("check","BDO 000123"))
        assertEquals(setOf(CheckoutProblem.REFERENCE_ALREADY_USED),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("check",null,"bdo 000123")),context(usedReferences = used))))
        assertTrue(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("gcash",null,"BDO 000123")),context(usedReferences = used)).ok)
        // A method without a reference ignores one.
        assertNull(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("voucher",null,"X1")),context()).quote!!.payment.reference)
    }
    @Test fun onlyConfiguredMethodsAreAccepted() {
        assertEquals(setOf(CheckoutProblem.UNKNOWN_PAYMENT_METHOD),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("crypto",null,null)),context())))
        // A policy without the list (older cache/server) allows cash only.
        val legacy = policy.copy(paymentMethods = PaymentMethod.CASH_ONLY)
        assertEquals(setOf(CheckoutProblem.UNKNOWN_PAYMENT_METHOD),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("check",null,"1")),context(policy = legacy))))
        assertTrue(CheckoutRules.evaluate(request(CartLine("p1",1)),context(policy = legacy)).ok)
        assertEquals(PaymentMethod.CASH_ONLY,VanPolicy().paymentMethods)
    }
    @Test fun creditNeedsOfficeTermsAndStaysWithinCreditLeft() {
        val quote = CheckoutRules.evaluate(request(CartLine("p1",2),customer = "o2",payment = PaymentInput("credit")),context()).quote!!
        assertEquals(PaymentState.ON_ACCOUNT,quote.payment.state); assertEquals("2026-11-06",quote.payment.dueDate)
        assertEquals(17_000L,quote.payment.amountMinor); assertEquals(0L,quote.changeMinor)
        assertEquals(setOf(CheckoutProblem.CREDIT_TERMS_UNAVAILABLE),problems(CheckoutRules.evaluate(request(CartLine("p1",1),payment = PaymentInput("credit")),context())))
        assertEquals(setOf(CheckoutProblem.CREDIT_TERMS_UNAVAILABLE),problems(CheckoutRules.evaluate(request(CartLine("p1",1),customer = "local:w1",payment = PaymentInput("credit")),context())))
        // ₱500.00 available, ₱400.00 already charged here: ₱85.00 fits, ₱170.00 does not.
        val used = mapOf("o2" to 40_000L)
        assertTrue(CheckoutRules.evaluate(request(CartLine("p1",1),customer = "o2",payment = PaymentInput("credit")),context(creditUsed = used)).ok)
        assertEquals(setOf(CheckoutProblem.CREDIT_LIMIT_EXCEEDED),problems(CheckoutRules.evaluate(request(CartLine("p1",2),customer = "o2",payment = PaymentInput("credit")),context(creditUsed = used))))
        assertEquals(10_000L,CheckoutRules.creditLeft(onTerms,context(creditUsed = used))); assertNull(CheckoutRules.creditLeft(route,context()))
        // Credit configured off: the customer's terms alone do not allow it.
        assertEquals(setOf(CheckoutProblem.UNKNOWN_PAYMENT_METHOD),problems(CheckoutRules.evaluate(request(CartLine("p1",1),customer = "o2",payment = PaymentInput("credit")),
            context(policy = policy.copy(paymentMethods = methods - creditMethod)))))
    }
    @Test fun cartQuoteShowsTheTotalBeforeAnyPayment() {
        val q = CheckoutRules.cartQuote(request(CartLine("p1",2),payment = PaymentInput("gcash")),context(policy = policy.copy(paymentMethods = listOf(gcash))))!!
        assertEquals(17_000L,q.totalMinor)
        assertEquals("Paid",VanRules.paymentStateLabel("paid",null)); assertEquals("Charged to account · due 2026-11-06",VanRules.paymentStateLabel("on_account","2026-11-06"))
        assertEquals("To be confirmed by the office",VanRules.paymentStateLabel("awaiting_confirmation",null))
    }

    // ── SP-0105 customer price lists and governed promotions ──
    @Test fun customerPriceListSelectsOnlyItsListAndExplicitNoneIsUnpriced() {
        val governed = route.copy(priceListId = "L2",priceListMode = CustomerPriceListMode.GOVERNED)
        val governedResult = CheckoutRules.evaluate(request(CartLine("p1",1)),context(
            prices = listOf(price("p1",8_500,list = "L1") .copy(priceListCode = "ROUTE"),price("p1",9_000,list = "L2").copy(priceListCode = "CUSTOMER")),customers = listOf(governed)))
        assertTrue(governedResult.ok)
        assertEquals(9_000L,governedResult.quote!!.lines.single().unitPriceMinor)
        assertEquals("L2",governedResult.quote.lines.single().priceListId)
        assertEquals("CUSTOMER",governedResult.quote.lines.single().priceListCode)
        val none = route.copy(priceListMode = CustomerPriceListMode.NONE,priceListId = null)
        val noneResult = CheckoutRules.evaluate(request(CartLine("p1",1)),context(customers = listOf(none)))
        assertEquals(setOf(CheckoutProblem.UNPRICED),problems(noneResult))
    }

    @Test fun buyTenGetOneAddsFreeUnitsToOneProductLineAndChecksTotalStock() {
        val promo = Promotion("promo-buy","PROMO-B10G1","Buy 10, get 1 free",null,now - 1,null,
            PromotionRule.BuyXGetY(PromotionUnit("p1","PC",10),PromotionUnit("p1","PC",1)))
        val quote = CheckoutRules.evaluate(request(CartLine("p1",21)),context(
            stock = listOf(TruckStock("p1",30,0)),promotions = listOf(promo))).quote!!
        val line = quote.lines.single()
        assertEquals(21L,line.paidBase); assertEquals(2L,line.freeBase); assertEquals(23L,line.quantityBase)
        assertEquals(178_500L,line.grossMinor); assertEquals(178_500L,line.totalMinor); assertEquals("PROMO-B10G1",line.promotion!!.code)
        val refused = CheckoutRules.evaluate(request(CartLine("p1",21)),context(
            stock = listOf(TruckStock("p1",21,0)),promotions = listOf(promo)))
        assertEquals(setOf(CheckoutProblem.INSUFFICIENT_STOCK),problems(refused))
    }

    @Test fun buyGetCanAppendFreeOnlyLineAndPercentOffRoundsDown() {
        val buyFree = Promotion("promo-gift","PROMO-GIFT","Gift chunks",null,now - 1,null,
            PromotionRule.BuyXGetY(PromotionUnit("p1","PC",2),PromotionUnit("p2","PC",1)))
        val giftQuote = CheckoutRules.evaluate(request(CartLine("p1",2)),context(
            prices = prices + price("p2",1_001),promotions = listOf(buyFree))).quote!!
        assertEquals(listOf("p1","p2"),giftQuote.lines.map { it.product.productId })
        assertEquals(0L,giftQuote.lines[1].paidBase); assertEquals(1L,giftQuote.lines[1].freeBase); assertEquals(0L,giftQuote.lines[1].totalMinor)
        val percent = Promotion("promo-percent","PROMO-5","Five percent",null,now - 1,null,
            PromotionRule.PercentOff(PromotionUnit("p1","PC",1),500))
        val percentQuote = CheckoutRules.evaluate(request(CartLine("p1",1)),context(
            prices = listOf(price("p1",999)),promotions = listOf(percent))).quote!!
        assertEquals(49L,percentQuote.lines.single().discountMinor); assertEquals(950L,percentQuote.totalMinor)
    }

    @Test fun bundlePricesCompleteSetsAndLeavesPartialUnitsAtNormalPrice() {
        val bundle = Promotion("promo-bundle","PROMO-BUNDLE","Juice and chunks",null,now - 1,null,
            PromotionRule.Bundle(listOf(PromotionUnit("p1","PC",1),PromotionUnit("p2","PC",1)),12_000))
        val quote = CheckoutRules.evaluate(request(CartLine("p1",3),CartLine("p2",2)),context(
            prices = listOf(price("p1",8_500),price("p2",4_275)),stock = listOf(TruckStock("p1",3,0),TruckStock("p2",2,0)),promotions = listOf(bundle))).quote!!
        assertEquals(1_550L,quote.lines.sumOf { it.discountMinor }); assertEquals(32_500L,quote.totalMinor)
        assertTrue(quote.lines.all { it.totalMinor >= 0L })
    }

    @Test fun promotionsConflictOrNeedOfficeAndIgnoredDatesAndListsFailClosed() {
        val percent = Promotion("promo-percent","PROMO-5","Five percent",null,now - 1,null,
            PromotionRule.PercentOff(PromotionUnit("p1","PC",1),500))
        val conflict = percent.copy(promotionId = "promo-buy",code = "PROMO-BUY",rule = PromotionRule.BuyXGetY(
            PromotionUnit("p1","PC",1),PromotionUnit("p1","PC",1)))
        val blocked = CheckoutRules.evaluate(request(CartLine("p1",2)),context(promotions = listOf(percent,conflict)))
        assertEquals(setOf(CheckoutProblem.PROMOTION_CONFLICT),problems(blocked))
        val wrongUom = percent.copy(promotionId = "promo-wrong",code = "PROMO-WRONG",rule = PromotionRule.PercentOff(PromotionUnit("p1","CS",1),500))
        assertEquals(setOf(CheckoutProblem.PROMOTION_NEEDS_OFFICE),problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(promotions = listOf(wrongUom)))))
        val missingFree = Promotion("promo-missing","PROMO-MISSING","Missing free product",null,now - 1,null,
            PromotionRule.BuyXGetY(PromotionUnit("p1","PC",1),PromotionUnit("missing","PC",1)))
        assertEquals(setOf(CheckoutProblem.PROMOTION_NEEDS_OFFICE),problems(CheckoutRules.evaluate(request(CartLine("p1",1)),context(promotions = listOf(missingFree)))))
        val unpricedBundle = Promotion("promo-unpriced","PROMO-UNPRICED","Unpriced bundle",null,now - 1,null,
            PromotionRule.Bundle(listOf(PromotionUnit("p1","PC",1),PromotionUnit("p2","PC",1)),1))
        assertEquals(setOf(CheckoutProblem.PROMOTION_NEEDS_OFFICE),problems(CheckoutRules.evaluate(request(CartLine("p1",1),CartLine("p2",1)),context(promotions = listOf(unpricedBundle)))))
        val expired = percent.copy(promotionId = "promo-expired",code = "PROMO-EXPIRED",effectiveFrom = now - 100,effectiveTo = now)
        val otherList = percent.copy(promotionId = "promo-other",code = "PROMO-OTHER",priceListId = "L2")
        val unaffected = CheckoutRules.evaluate(request(CartLine("p1",1)),context(promotions = listOf(expired,otherList)))
        assertTrue(unaffected.ok); assertEquals(8_500L,unaffected.quote!!.totalMinor)
    }
}
