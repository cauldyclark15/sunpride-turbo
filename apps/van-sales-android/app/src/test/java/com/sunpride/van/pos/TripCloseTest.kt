package com.sunpride.van.pos

import com.sunpride.van.data.TripClosePolicy
import com.sunpride.van.data.VanPolicy
import org.junit.Assert.*
import org.junit.Test

/** VAN-024 trip close checklist, exceptions and review rules (the store repeats them in its transaction). */
class TripCloseTest {
    private val id = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f"
    private val strict = TripClosePolicy.STRICT
    private val ready = TripCloseFacts(tripOnRoad = true, held = false, cashCounted = true, stockCounted = true, waitingUploads = 0,
        saleStockIssues = 0, unprintedReceipts = 0, officeRefused = 0, cashVarianceMinor = 0, stockVarianceLines = 0)
    private fun refused(expected: CloseProblem, facts: TripCloseFacts = ready, policy: TripClosePolicy = strict,
        request: TripCloseRequest = TripCloseRequest(id, null, null, null), startKm: Double? = null) {
        val checklist = TripCloseRules.checklist(facts, policy)
        assertEquals(expected, assertThrows(TripCloseRefused::class.java) { TripCloseRules.authorize(checklist, policy, request, startKm) }.problem)
    }

    @Test fun aCleanTripClosesWithNothingToCheck() {
        val checklist = TripCloseRules.checklist(ready, strict)
        assertTrue(checklist.ready); assertTrue(checklist.exceptions.isEmpty()); assertEquals("", checklist.reviewCode)
        assertFalse(TripCloseRules.needsReview(checklist, strict))
        assertFalse(TripCloseRules.authorize(checklist, strict, TripCloseRequest(id, null, 12345.5, " end of day "), 12000.0))
    }

    @Test fun eachRequiredStepBlocksWithItsOwnProblemInOrder() {
        refused(CloseProblem.NOT_ON_ROUTE, ready.copy(tripOnRoad = false, cashCounted = false))
        refused(CloseProblem.HELD, ready.copy(held = true))
        refused(CloseProblem.CASH_NOT_COUNTED, ready.copy(cashCounted = false, stockCounted = false))
        refused(CloseProblem.STOCK_NOT_COUNTED, ready.copy(stockCounted = false))
        refused(CloseProblem.UPLOADS_WAITING, ready.copy(waitingUploads = 2))
        refused(CloseProblem.SALES_STOCK_DISAGREE, ready.copy(saleStockIssues = 1))
        val blocked = TripCloseRules.checklist(ready.copy(waitingUploads = 3), strict)
        assertEquals(listOf(CloseStep.UPLOADS_SENT), blocked.blockers.map { it.step }); assertEquals(3, blocked.blockers.single().count)
    }

    @Test fun policyCanWaiveCountsAndUploadsButNeverTheTripPhoneOrStockAgreement() {
        val lenient = TripClosePolicy(requireCashCount = false, requireStockCount = false, requireUploadsSent = false, exceptionsNeedReview = false)
        val facts = ready.copy(cashCounted = false, stockCounted = false, waitingUploads = 4, cashVarianceMinor = null, stockVarianceLines = null)
        assertTrue(TripCloseRules.checklist(facts, lenient).ready)
        refused(CloseProblem.NOT_ON_ROUTE, facts.copy(tripOnRoad = false), lenient)
        refused(CloseProblem.HELD, facts.copy(held = true), lenient)
        refused(CloseProblem.SALES_STOCK_DISAGREE, facts.copy(saleStockIssues = 1), lenient)
    }

    @Test fun missingPolicyIsStrict() {
        assertEquals(TripClosePolicy.STRICT, TripCloseRules.policy(null))
        assertEquals(TripClosePolicy.STRICT, TripCloseRules.policy(VanPolicy()))
        val custom = TripClosePolicy(false, true, true, false)
        assertEquals(custom, TripCloseRules.policy(VanPolicy(tripClose = custom)))
    }

    @Test fun exceptionsMustBeConfirmedAndAnyChangeNeedsAFreshConfirmation() {
        val facts = ready.copy(unprintedReceipts = 2, officeRefused = 1, cashVarianceMinor = -12000, stockVarianceLines = 3)
        val checklist = TripCloseRules.checklist(facts, strict)
        assertEquals(listOf(CloseExceptionKind.UNPRINTED_RECEIPTS, CloseExceptionKind.OFFICE_REFUSED, CloseExceptionKind.CASH_DIFFERENCE,
            CloseExceptionKind.STOCK_DIFFERENCE), checklist.exceptions.map { it.kind })
        assertEquals("unprinted_receipts=2;office_refused=1;cash_difference=-12000;stock_difference=3", checklist.reviewCode)
        assertTrue(checklist.ready); assertTrue(TripCloseRules.needsReview(checklist, strict))
        refused(CloseProblem.REVIEW_REQUIRED, facts)
        // The seller confirmed 2 unprinted receipts, but a third appeared before saving.
        refused(CloseProblem.EXCEPTIONS_CHANGED, facts.copy(unprintedReceipts = 3), request = TripCloseRequest(id, checklist.reviewCode, null, null))
        assertTrue(TripCloseRules.authorize(checklist, strict, TripCloseRequest(id, checklist.reviewCode, null, null), null))
        // Without the review rule exceptions are still recorded but need no confirmation.
        val noReview = strict.copy(exceptionsNeedReview = false)
        assertFalse(TripCloseRules.authorize(TripCloseRules.checklist(facts, noReview), noReview, TripCloseRequest(id, null, null, null), null))
    }

    @Test fun matchingCashAndStockAreNotExceptions() {
        assertTrue(TripCloseRules.checklist(ready.copy(cashVarianceMinor = 0, stockVarianceLines = 0), strict).exceptions.isEmpty())
        assertEquals(listOf(CloseException(CloseExceptionKind.CASH_DIFFERENCE, 5000)),
            TripCloseRules.checklist(ready.copy(cashVarianceMinor = 5000), strict).exceptions)
    }

    @Test fun idOdometerAndNoteAreValidated() {
        refused(CloseProblem.CLOSE_INVALID, request = TripCloseRequest("not-a-uuid", null, null, null))
        refused(CloseProblem.CLOSE_INVALID, ready.copy(cashCounted = false), request = TripCloseRequest("not-a-uuid", null, null, null))
        refused(CloseProblem.ODOMETER_INVALID, request = TripCloseRequest(id, null, 999.0, null), startKm = 1000.0)
        refused(CloseProblem.ODOMETER_INVALID, request = TripCloseRequest(id, null, Double.NaN, null))
        refused(CloseProblem.ODOMETER_INVALID, request = TripCloseRequest(id, null, -1.0, null))
        refused(CloseProblem.ODOMETER_INVALID, request = TripCloseRequest(id, null, 10_000_001.0, null))
        refused(CloseProblem.NOTE_INVALID, request = TripCloseRequest(id, null, null, "x".repeat(301)))
        refused(CloseProblem.NOTE_INVALID, request = TripCloseRequest(id, null, null, "bad\u0000note"))
        assertTrue(TripCloseRules.validOdometer(1000.0, 1000.0)); assertTrue(TripCloseRules.validOdometer(null, 1000.0))
        assertNull(TripCloseRules.normalizedNote("   ")); assertEquals("ok", TripCloseRules.normalizedNote(" ok "))
        assertTrue(TripCloseRules.validId(TripCloseRules.newCloseId()))
    }
}
