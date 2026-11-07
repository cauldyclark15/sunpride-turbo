package com.sunpride.van.pos

import com.sunpride.van.data.*
import com.sunpride.van.selling.DiscountClaim
import com.sunpride.van.selling.PrivilegeType
import com.sunpride.van.selling.TaxFact
import org.junit.Assert.*
import org.junit.Test

/** IP-HH2: the discount claim and the split tender inside the SAME checkout engine the screens and the store use. */
class DiscountClaimCheckoutTest {
    private val now = 1_791_338_400_000L
    private val juice = Product("p1", "SP-PJ-1L", "Pineapple Juice 1L", "PC", 1, emptyList())        // ₱39.00 VATable
    private val noodles = Product("p2", "SP-ND", "Instant Noodles", "PC", 1, emptyList())             // ₱112.00 VAT exempt
    private val ice = Product("p3", "SP-IC", "Ice Cream Tub", "PC", 1, emptyList())                   // ₱50.00 zero rated
    private val route = Customer("o1", "O-1001", "Aling Nena Store", null, 1, "route")
    private val onTerms = Customer("o2", "O-1002", "JM Sari-Sari", null, 2, "route", credit = CustomerCredit(30, 50_000))
    private val gcash = PaymentMethod("gcash", "GCash", PaymentKind.OTHER, true, "GCash reference number")
    private val credit = PaymentMethod("credit", "Credit (charge to account)", PaymentKind.CREDIT, false, null)
    private val policy = VanPolicy(paymentMethods = listOf(PaymentMethod.CASH, gcash, credit))
    private val saleId = "6f1c1f3e-2b7a-4c55-9d1e-0c4b8f7a1a01"
    private val prices = listOf(PriceLine("L1", "p1", "PC", 3_900, "PHP", now - 1, null), PriceLine("L1", "p2", "PC", 11_200, "PHP", now - 1, null), PriceLine("L1", "p3", "PC", 5_000, "PHP", now - 1, null))
    private val taxes = mapOf("p1" to TaxFact("vatable", 1200), "p2" to TaxFact("exempt", 0), "p3" to TaxFact("zero_rated", 0))
    private fun context(facts: ((QuotedLine, String?) -> TaxFact?)? = { q, _ -> taxes[q.product.productId] }) = CheckoutContext(true, listOf(route, onTerms), listOf(juice, noodles, ice),
        listOf(TruckStock("p1", 50, 0), TruckStock("p2", 50, 0), TruckStock("p3", 50, 0)), prices, policy, now, "2026-10-07", taxFacts = facts)
    private fun senior(eligible: Set<String>? = null) = DiscountClaim(PrivilegeType.SENIOR, "SC-123456", "Juan Dela Cruz", eligible)
    private fun request(lines: List<CartLine>, payment: PaymentInput, claim: DiscountClaim? = null, split: SplitPayment? = null, customer: String = "o1") =
        CheckoutRequest(saleId, customer, lines, payment, claim = claim, split = split)

    @Test fun thirtyNinePesosWithASeniorClaimIsTwentySevenPesosEightySix() {
        val r = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_000), senior()), context())
        assertTrue(r.issues.toString(), r.ok)
        val q = r.quote!!
        assertEquals(2_786L, q.totalMinor); assertEquals(2_786L, q.lines.single().totalMinor); assertEquals(3_900L, q.lines.single().grossMinor)
        assertEquals(696L, q.lines.single().privilegeDiscountMinor); assertEquals(418L, q.lines.single().vatRemovedMinor); assertEquals(PrivilegeType.SENIOR, q.lines.single().privilegeType)
        assertEquals(214L, q.changeMinor); assertEquals(2_786L, q.payment.amountMinor)
        assertEquals(2_786L, q.legal!!.total); assertTrue(q.legal!!.applied)
    }

    @Test fun aMixedCartOnlyDiscountsTheEligibleItems() {
        val lines = listOf(CartLine("p1", 1), CartLine("p2", 1), CartLine("p3", 1))
        val q = CheckoutRules.evaluate(request(lines, PaymentInput("cash", 20_000), senior(setOf("p1", "p2"))), context()).quote!!
        assertEquals(listOf(2_786L, 8_960L, 5_000L), q.lines.map { it.totalMinor })
        assertEquals(16_746L, q.totalMinor); assertEquals(3_254L, q.changeMinor)
        assertEquals(0L, q.lines[2].privilegeDiscountMinor)
        // the sale without a claim is untouched
        assertEquals(3_900L + 11_200L + 5_000L, CheckoutRules.evaluate(request(lines, PaymentInput("cash", 25_000)), context()).quote!!.totalMinor)
    }

    @Test fun anItemRemovedFromTheCartIsNoLongerNamedAsEligible() {
        val q = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_000), senior(setOf("p1", "p2"))), context()).quote!!
        assertEquals(setOf("p1"), q.claim!!.eligibleProductIds)
    }

    @Test fun anItemWithNoTaxSetupRefusesTheClaimInPlainWordsNotAGuess() {
        val r = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_900), senior()), context(facts = null))
        assertNull(r.quote); assertEquals(CheckoutProblem.DISCOUNT_TAX_UNKNOWN, r.issues.single().problem); assertEquals("p1", r.issues.single().productId)
        val partial = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1), CartLine("p2", 1)), PaymentInput("cash", 20_000), senior()), context(facts = { q, _ -> taxes[q.product.productId]?.takeIf { q.product.productId != "p2" } }))
        assertEquals(listOf(CheckoutIssue(CheckoutProblem.DISCOUNT_TAX_UNKNOWN, "p2")), partial.issues)
    }

    @Test fun aClaimNeedsTheIdAndTheNameAndNeverStacksWithAManualDiscount() {
        val bad = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_900), DiscountClaim(PrivilegeType.PWD, "", "Ana")), context())
        assertEquals(CheckoutProblem.DISCOUNT_CLAIM_INVALID, bad.issues.single().problem)
        val manual = CheckoutRequest(saleId, "o1", listOf(CartLine("p1", 1)), PaymentInput("cash", 3_900), ManualDiscountInput(lineMinor = mapOf("p1" to 100L), reason = "Damaged box"), claim = senior())
        assertTrue(CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL in CheckoutRules.evaluate(manual, context()).issues.map { it.problem })
    }

    @Test fun cashPlusGcashPaysTheRestInCashAndChangeComesOnlyFromCash() {
        val split = SplitPayment("gcash", 3_000, "GC-12345")
        val r = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1), CartLine("p2", 1)), PaymentInput("cash", 12_100), split = split), context())
        assertTrue(r.issues.toString(), r.ok)
        val q = r.quote!!
        assertEquals(15_100L, q.totalMinor)
        assertEquals(12_100L, q.split!!.cash.amountMinor); assertEquals(12_100L, q.split!!.cash.tenderedMinor)
        assertEquals(3_000L, q.split!!.other.amountMinor); assertEquals("GC-12345", q.split!!.other.reference); assertEquals(PaymentState.AWAITING_CONFIRMATION, q.split!!.other.state)
        assertNull("the other tender never gives change", q.split!!.other.tenderedMinor)
        assertEquals(0L, q.changeMinor)
    }

    @Test fun cashHandedOverBeyondTheCashPartGivesChangeAndShortCashIsRefused() {
        val split = SplitPayment("gcash", 3_000, "GC-1")
        val over = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1), CartLine("p2", 1)), PaymentInput("cash", 15_000), split = split), context()).quote!!
        assertEquals(2_900L, over.changeMinor)
        val short = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1), CartLine("p2", 1)), PaymentInput("cash", 12_000), split = split), context())
        assertEquals(CheckoutProblem.CASH_SHORT, short.issues.single().problem)
    }

    @Test fun aSplitNeedsTwoRealPartsAndADifferentSecondTender() {
        fun problems(split: SplitPayment) = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 5_000), split = split), context()).issues.map { it.problem }
        assertEquals(listOf(CheckoutProblem.SPLIT_INVALID), problems(SplitPayment("gcash", 0, "R-1")))
        assertEquals(listOf(CheckoutProblem.SPLIT_INVALID), problems(SplitPayment("gcash", 3_900, "R-1")))
        assertEquals(listOf(CheckoutProblem.SPLIT_INVALID), problems(SplitPayment("cash", 1_000)))
        assertEquals(listOf(CheckoutProblem.SPLIT_INVALID), problems(SplitPayment("nope", 1_000)))
        assertEquals(listOf(CheckoutProblem.REFERENCE_MISSING), problems(SplitPayment("gcash", 1_000)))
    }

    @Test fun theSecondTenderCanBeCreditWithinTheLimitAndAClaimWorksWithASplit() {
        val onCredit = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 1_000), split = SplitPayment("credit", 2_900), customer = "o2"), context())
        assertTrue(onCredit.issues.toString(), onCredit.ok)
        assertEquals(PaymentState.ON_ACCOUNT, onCredit.quote!!.split!!.other.state); assertEquals("2026-11-06", onCredit.quote!!.split!!.other.dueDate)
        val tooMuch = CheckoutRules.evaluate(request(listOf(CartLine("p2", 10)), PaymentInput("cash", 1_000), split = SplitPayment("credit", 60_000), customer = "o2"), context())
        assertTrue(CheckoutProblem.CREDIT_LIMIT_EXCEEDED in tooMuch.issues.map { it.problem })
        val both = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 1_786), senior(), SplitPayment("gcash", 1_000, "R-9")), context())
        assertTrue(both.issues.toString(), both.ok); assertEquals(2_786L, both.quote!!.totalMinor); assertEquals(1_786L, both.quote!!.split!!.cash.amountMinor)
    }

    @Test fun theCartQuoteIgnoresTheSplitSoTheTotalShowsBeforeThePaymentIsChosen() {
        val q = CheckoutRules.cartQuote(request(listOf(CartLine("p1", 1)), PaymentInput("cash"), senior(), SplitPayment("gcash", 1_000, "R-9")), context())
        assertEquals(2_786L, q!!.totalMinor); assertNull(q.split)
    }

    // IP-SCPWD-CAP: the weekly limit inside the same checkout engine the screens and the store use.
    @Test fun theWeeklyLimitGivesTheDiscountOnlyToWhatIsLeftAndTheClaimCarriesTheBudget() {
        val ctx = context().copy(capRemaining = { 1_000L })
        val q = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_900), senior()), ctx).quote!!
        assertEquals(3_614L, q.totalMinor); assertEquals(179L, q.legal!!.privilegeDiscount); assertEquals(107L, q.legal!!.vatRemoved)
        assertEquals(1_000L, q.legal!!.appliedGross); assertEquals(3_900L, q.legal!!.eligibleGross)
        assertEquals(1_000L, q.claim!!.capBudget)
        val wire = q.claim!!.json("privilegeDiscountCentavos", "vatRemovedCentavos", q.legal)
        assertEquals("1000", wire.getJSONObject("capBasis").getString("budgetCentavos"))
        // nothing left: the case sells at the shelf price and the claim still says the phone worked with a limit of 0
        val none = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_900), senior()), context().copy(capRemaining = { 0L })).quote!!
        assertEquals(3_900L, none.totalMinor); assertFalse(none.legal!!.applied); assertEquals(0L, none.claim!!.capBudget)
    }

    @Test fun aPhoneThatKnowsOfNoLimitSellsAndSendsExactlyWhatItDidBefore() {
        for (ctx in listOf(context(), context().copy(capRemaining = { null }))) {
            val q = CheckoutRules.evaluate(request(listOf(CartLine("p1", 1)), PaymentInput("cash", 3_000), senior()), ctx).quote!!
            assertEquals(2_786L, q.totalMinor); assertNull(q.claim!!.capBudget)
            assertFalse(q.claim!!.json("privilegeDiscountCentavos", "vatRemovedCentavos", q.legal).has("capBasis"))
        }
    }
}
