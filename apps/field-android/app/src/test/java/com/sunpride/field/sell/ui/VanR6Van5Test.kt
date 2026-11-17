package com.sunpride.field.sell.ui

import com.sunpride.field.sell.pos.CloseOffice
import com.sunpride.field.sell.pos.CloseOfficeRules
import com.sunpride.field.sell.pos.TripCloseRules
import com.sunpride.field.sell.printing.PrintResult
import com.sunpride.field.sell.printing.PrinterAlertWatch
import com.sunpride.field.sell.printing.PrinterStatus
import com.sunpride.field.sell.printing.PrinterWords
import com.sunpride.field.sell.sync.V2VanCodec
import com.sunpride.field.sell.sync.VanSyncFailure
import com.sunpride.field.sell.vanday.DayFacts
import com.sunpride.field.sell.vanday.StepKind
import com.sunpride.field.sell.vanday.VanDaySteps
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** r6van5: VAN-083, VAN-081, VAN-082, VAN-002, POS-042, POS-043. */
class VanR6Van5Test {
    private fun op(type: String, id: String) = JSONObject().put("clientOpId", id).put("opType", type)
    private fun answer(type: String, id: String, code: String, retryable: Boolean) = JSONObject().put("version", 2).put("results",
        JSONArray().put(JSONObject().put("clientOpId", id).put("opType", type).put("status", "rejected").put("code", code).put("retryable", retryable)))

    // VAN-083: "receive the cash first" is a wait, not a refusal: the close stays queued and is sent again.
    @Test fun closeWaitingForOfficeCashIsKeptNotRefused() {
        val r = V2VanCodec.results(answer("trip.close", "c1", "dependency_missing", true), listOf(op("trip.close", "c1"))).single()
        assertEquals("waiting", r.status)
        assertEquals(CloseOfficeRules.WAITING_CASH_CODE, r.code)
        // Any other temporary refusal still stops the sync for a later retry, as before.
        assertThrows(VanSyncFailure::class.java) {
            V2VanCodec.results(answer("sale.record", "s1", "places_unavailable", true), listOf(op("sale.record", "s1")))
        }
        // A permanent refusal of the close is still a refusal.
        assertEquals("rejected", V2VanCodec.results(answer("trip.close", "c2", "invalid_transition", false), listOf(op("trip.close", "c2"))).single().status)
    }

    @Test fun closedOnThePhoneIsNotClosedUntilTheOfficeAccepts() {
        assertEquals(CloseOffice.WAITING_FOR_CASH, CloseOfficeRules.state(true, "pending", CloseOfficeRules.WAITING_CASH_CODE, "reconciling"))
        assertEquals(CloseOffice.WAITING_TO_SEND, CloseOfficeRules.state(true, "pending", null, "reconciling"))
        assertEquals(CloseOffice.ACCEPTED, CloseOfficeRules.state(true, "done", null, "reconciling"))
        assertEquals(CloseOffice.ACCEPTED, CloseOfficeRules.state(true, null, null, "closed"))
        assertEquals(CloseOffice.REFUSED, CloseOfficeRules.state(true, "rejected", "invalid_transition", "reconciling"))
        assertEquals(CloseOffice.NOT_CLOSED, CloseOfficeRules.state(false, null, null, "active"))

        val closed = DayFacts(true, "reconciling", false, null, false, null, true, true, true, false, false, null, 0, false)
        val waiting = VanDaySteps.next(closed.copy(closeOffice = CloseOffice.WAITING_FOR_CASH))
        assertEquals(StepKind.WAIT, waiting.kind)
        assertEquals("Waiting for the office", waiting.title)
        assertTrue(waiting.detail.contains("confirm it received the cash"))
        assertEquals(StepKind.DONE, VanDaySteps.next(closed.copy(closeOffice = CloseOffice.ACCEPTED)).kind)
        assertEquals("Trip closed", CloseOfficeRules.title(CloseOffice.ACCEPTED))
    }

    // VAN-081: the start reading comes with the trip; a lower end reading is refused with a message; unknown start is asked.
    @Test fun endOdometerIsCheckedAgainstTheTripStart() {
        val policy = JSONObject().put("tripFacts", JSONObject().put("startOdometerKm", 48210))
        assertEquals(48210.0, TripCloseRules.startFromPolicy(policy)!!, 0.0)
        assertNull(TripCloseRules.startFromPolicy(JSONObject().put("tripFacts", JSONObject().put("startOdometerKm", JSONObject.NULL))))
        assertNull(TripCloseRules.startFromPolicy(JSONObject()))

        assertEquals("The end odometer (48000 km) cannot be lower than at the start (48210 km).", VanRules.closeOdometerProblem("48000", 48210.0, "", false))
        assertNull(VanRules.closeOdometerProblem("48262", 48210.0, "", false))
        assertNull(VanRules.closeOdometerProblem("", 48210.0, "", false))
        assertEquals("Enter the closing odometer in km.", VanRules.closeOdometerProblem("", 48210.0, "", true))
        assertTrue(VanRules.closeOdometerProblem("48000", null, "", false)!!.contains("Enter the reading at the start"))
        assertNotNull(VanRules.closeOdometerProblem("48000", null, "48210", false))
        assertNull(VanRules.closeOdometerProblem("48262", null, "48210", false))
        assertNotNull(VanRules.closeOdometerProblem("4826x", 48210.0, "", false))
    }

    // VAN-082: the tap without the tick has a message (shown next to the button and the tick box).
    @Test fun closeWithoutTickSaysWhatToDo() {
        assertEquals("Check the items below and tick the box before closing.", VanRules.closeTapMessage(true, true, false))
        assertNull(VanRules.closeTapMessage(true, true, true))
    }

    // VAN-002: the printer's own "Paper is not ready" alert after a job turns the result into a failure.
    @Test fun printerAlertAfterAJobIsAPrintFailure() = runBlocking {
        PrinterAlertWatch.resetForTest()
        var now = 1_000L
        PrinterAlertWatch.focusChanged(false, 900) // before the job: not this job's alert
        assertFalse(PrinterAlertWatch.awaitAlert(1_000, 500, { now }, { now += it }))
        now = 2_000L
        val job = 2_150L
        assertTrue(PrinterAlertWatch.awaitAlert(2_000, 500, { now }, { now += it; if (now >= job) PrinterAlertWatch.focusChanged(false, now) }))
        assertEquals("Print failed: Out of paper. Load paper, then print again.", PrinterWords.testResult(PrintResult.Error(PrinterStatus.PaperOut)))
        assertEquals(PrinterWords.TEST_SENT, PrinterWords.testResult(PrintResult.Success))
    }
    // SP-0192: the store-mode count and receive checks stay in the Van app (store mode is not part of the Field app).

}
