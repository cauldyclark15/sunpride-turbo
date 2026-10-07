package com.sunpride.van.pos

import com.sunpride.van.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CashReconciliationTest {
    private val key = "PnoIS45xGmCnubWwLVAmPBjjgF-prN3ykOOEvfv5zsY"
    private val rule = CashReconciliationPolicy(true,5000,CashVarianceReasons.ALL.map { it.code },key)
    private val policy = VanPolicy(cashReconciliation = rule)
    private fun pay(kind: PaymentKind, amount: Long, voided: Boolean = false, code: String = kind.wire, currency: String = "PHP") =
        TripPayment("s$amount$code","R-$amount",code,code.uppercase(),kind,amount,currency,voided)
    private fun problem(expected: CashProblem, p: VanPolicy? = policy, declared: Long = 90_000, reason: String? = "counting_error",
        note: String? = null, code: String? = null) {
        assertEquals(expected,assertThrows(CashRefused::class.java) { CashReconciliationRules.authorize(p,"t",100_000,declared,reason,note,code) }.problem)
    }

    @Test fun sharedVectorsAreReadInPlaceAndEveryBoundFactIsChecked() {
        val v = JSONObject(javaClass.classLoader!!.getResourceAsStream("cash-approval.json")!!.bufferedReader().use { it.readText() })
        assertEquals(key,v.getString("key"))
        val cases = v.getJSONArray("cases")
        assertTrue(cases.length() >= 3)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i); val trip = v.getString("tripId")
            val e = c.getString("expectedMinor").toLong(); val d = c.getString("declaredMinor").toLong()
            val reason = c.getString("reasonCode"); val expected = c.getString("code")
            assertEquals(expected,CashApprovalCodes.code(key,trip,e,d,reason))
            assertTrue(CashApprovalCodes.verify(key,trip,e,d,reason,expected))
            assertFalse(CashApprovalCodes.verify(key,trip,e+1,d,reason,expected))
            assertFalse(CashApprovalCodes.verify(key,trip,e,d+1,reason,expected))
            assertFalse(CashApprovalCodes.verify(key,trip,e,d,"counterfeit",expected))
            assertFalse(CashApprovalCodes.verify(key,trip+"x",e,d,reason,expected))
        }
    }
    @Test fun aVoidCodeForTheSameTripNeverApprovesCash() {
        val v = JSONObject(javaClass.classLoader!!.getResourceAsStream("void-approval.json")!!.bufferedReader().use { it.readText() })
        assertNotEquals(v.getString("key"),key)
        // The same cash facts signed with the trip's void key are refused by the cash key.
        val forged = CashApprovalCodes.code(v.getString("key"),"t",100_000,90_000,"counting_error")
        assertFalse(CashApprovalCodes.verify(key,"t",100_000,90_000,"counting_error",forged))
    }
    @Test fun expectedCashIsCashPaymentsOfSalesNotVoidedAndOtherMethodsAreListedApart() {
        val e = CashReconciliationRules.expectation(listOf(pay(PaymentKind.CASH,20550),pay(PaymentKind.CASH,8550),
            pay(PaymentKind.CASH,99_900,voided = true),pay(PaymentKind.OTHER,12_000,code = "gcash"),pay(PaymentKind.OTHER,3_000,code = "gcash"),
            pay(PaymentKind.CREDIT,50_000),pay(PaymentKind.OTHER,7_000,voided = true,code = "check")))
        assertEquals(29100L,e.expectedMinor); assertEquals(2,e.cashSales); assertEquals(2,e.voidedSales); assertEquals("PHP",e.currency)
        assertEquals(listOf(Triple("gcash",2,15_000L),Triple("credit",1,50_000L)),e.others.map { Triple(it.code,it.count,it.amountMinor) })
        val empty = CashReconciliationRules.expectation(emptyList())
        assertEquals(0L,empty.expectedMinor); assertEquals("PHP",empty.currency)
        assertEquals(CashProblem.MIXED_CURRENCY,assertThrows(CashRefused::class.java) {
            CashReconciliationRules.expectation(listOf(pay(PaymentKind.CASH,1),pay(PaymentKind.CASH,2,currency = "USD"))) }.problem)
    }
    @Test fun declaredCashAddsKnownDenominationsAndRefusesAnythingElse() {
        assertEquals(1_234_525L,CashReconciliationRules.declared(mapOf(100_000L to 12L,10_000L to 3L,2_000L to 2L,500L to 1L,25L to 1L)))
        assertEquals(0L,CashReconciliationRules.declared(emptyMap()))
        assertNull(CashReconciliationRules.declared(mapOf(300L to 1L)))
        assertNull(CashReconciliationRules.declared(mapOf(100L to -1L)))
        assertNull(CashReconciliationRules.declared(mapOf(100L to CashDenominations.MAX_PIECES+1)))
        assertEquals(0L,CashReconciliationRules.parsePieces(" ")); assertEquals(12L,CashReconciliationRules.parsePieces("12"))
        listOf("-1","1.5","１２","1e3","100001","1 2").forEach { assertNull(it,CashReconciliationRules.parsePieces(it)) }
    }
    @Test fun approvalIsNeededOnlyAboveTheToleranceEitherWayAndFailsClosedWithoutARule() {
        assertFalse(CashReconciliationRules.needsApproval(policy,0)); assertFalse(CashReconciliationRules.needsApproval(policy,5000))
        assertFalse(CashReconciliationRules.needsApproval(policy,-5000)); assertTrue(CashReconciliationRules.needsApproval(policy,5001))
        assertTrue(CashReconciliationRules.needsApproval(policy,-5001))
        assertFalse(CashReconciliationRules.needsApproval(VanPolicy(cashReconciliation = rule.copy(approvalRequired = false)),-999_999))
        assertTrue(CashReconciliationRules.needsApproval(VanPolicy(),1)); assertFalse(CashReconciliationRules.needsApproval(null,0))
    }
    @Test fun aMatchingCountNeedsNothingAndKeepsNoReason() {
        assertEquals(CashAuthorization(null,null,"none",null),CashReconciliationRules.authorize(VanPolicy(),"t",100,100,"counting_error",null,null))
    }
    @Test fun aSmallDifferenceNeedsOnlyAReason() {
        assertEquals(CashAuthorization("change_error","Gave ₱20 too much","none",null),
            CashReconciliationRules.authorize(policy,"t",100_000,98_000,"change_error"," Gave ₱20 too much ",null))
        problem(CashProblem.REASON_REQUIRED,declared = 99_000,reason = null)
        problem(CashProblem.REASON_REQUIRED,declared = 99_000,reason = "unknown")
        problem(CashProblem.NOTE_REQUIRED,declared = 99_000,reason = "other",note = "  ")
        problem(CashProblem.NOTE_INVALID,declared = 99_000,note = "bad\n")
        // Only the office's reasons are offered, in its order.
        problem(CashProblem.REASON_REQUIRED,p = VanPolicy(cashReconciliation = rule.copy(reasons = listOf("other"))),declared = 99_000)
        assertEquals(listOf("other","counterfeit"),CashVarianceReasons.offered(VanPolicy(cashReconciliation = rule.copy(reasons = listOf("x","other","counterfeit")))).map { it.code })
    }
    @Test fun aLargeDifferenceNeedsTheSupervisorCodeForTheseExactFacts() {
        val code = CashApprovalCodes.code(key,"t",100_000,90_000,"counting_error")
        assertEquals(CashAuthorization("counting_error",null,"supervisor_code",code),
            CashReconciliationRules.authorize(policy,"t",100_000,90_000,"counting_error",null,"${code.take(4)}-${code.drop(4)}"))
        problem(CashProblem.CODE_REQUIRED)
        problem(CashProblem.CODE_REQUIRED,code = "1234")
        problem(CashProblem.CODE_WRONG,code = CashApprovalCodes.code(key,"t",100_000,90_001,"counting_error"))
        problem(CashProblem.CODE_WRONG,code = CashApprovalCodes.code(key,"t",100_000,90_000,"lost_or_stolen"))
        problem(CashProblem.APPROVAL_UNAVAILABLE,p = VanPolicy(cashReconciliation = rule.copy(key = null)),code = code)
        problem(CashProblem.APPROVAL_UNAVAILABLE,p = VanPolicy(),code = code)
    }
}
