package com.sunpride.field.storage

import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** AND-017: End confirmation, the queued result, and the store's no-edits-after-End guard. */
class VisitCompletionTest {
    private val scope = StoreScope("a", "d", "s")
    private val rules = listOf(
        ActivityRule("merchandise", "v1", listOf(RuleActivity("merchandising", true), RuleActivity("price_check", false))),
        ActivityRule("future", "v4", listOf(RuleActivity("future_form", true))))
    private var n = 0
    private fun uuid() = "00000000-0000-4000-8000-%012d".format(++n)
    private val start = 1_000_000L
    private val checkIn = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, "planned-1", "outlet-1",
        listOf("merchandise", "future"), null, null, null, null, null, at = start, uuid = ::uuid)
    private fun activity(kind: String, at: Long) = VisitIntentFactory.create(scope, "visit.activity", checkIn.clientVisitId,
        checkIn.requestId, checkIn.requestId, null, "outlet-1", emptyList(), null, if (kind == "note") "n" else null, null, null,
        null, at = at, uuid = ::uuid, activity = if (kind == "note") null
            else JSONObject().put("kind", kind).put("displayCondition", "compliant").put("actionTaken", ""))
    private fun end(outcome: String, reason: String?, location: JSONObject?, at: Long) = VisitIntentFactory.create(scope,
        "visit.checkOut", checkIn.clientVisitId, checkIn.requestId, checkIn.requestId, null, "outlet-1", emptyList(), null,
        null, outcome, reason, location, at = at, uuid = ::uuid)
    private val fix = { at: Long, accuracy: Int -> JSONObject().put("latitude", 14.5).put("longitude", 121.0)
        .put("accuracyMeters", accuracy).put("fixTime", at).put("provider", "gps").put("mockSignal", false) }

    @Test fun reviewRefusesWhatEndWouldRefuseAndSummarisesTheRest() {
        val open = listOf(checkIn to "done")
        assertEquals(VisitRuleFailure.Code.OUTCOME_REQUIRED, assertThrows(VisitRuleFailure::class.java) {
            VisitCompletion.review(checkIn.clientVisitId, null, null, rules, open, null, start) }.code)
        assertEquals(VisitRuleFailure.Code.REASON_REQUIRED, assertThrows(VisitRuleFailure::class.java) {
            VisitCompletion.review(checkIn.clientVisitId, "nonproductive", " ", rules, open, null, start) }.code)
        assertEquals(VisitRuleFailure.Code.ACTIVITIES_REQUIRED, assertThrows(VisitRuleFailure::class.java) {
            VisitCompletion.review(checkIn.clientVisitId, "completed", null, rules, open, null, start) }.code)
        val rows = open + (activity("merchandising", start + 60_000) to "pending")
        val review = VisitCompletion.review(checkIn.clientVisitId, "completed", null, rules, rows, null, start + 12 * 60_000)
        assertEquals(EndReview("completed", null, listOf("merchandising"), listOf("future_form"), emptyList(), 12), review)
        val nonproductive = VisitCompletion.review(checkIn.clientVisitId, "nonproductive", " store_closed ", rules, open, null, start)
        assertEquals("store_closed", nonproductive.reasonCode)
        assertTrue(nonproductive.recorded.isEmpty())
        val ended = rows + (end("completed", null, null, start + 13 * 60_000) to "pending")
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, assertThrows(VisitRuleFailure::class.java) {
            VisitCompletion.review(checkIn.clientVisitId, "completed", null, rules, ended, null, start) }.code)
    }

    @Test fun resultReadsTheQueuedEndAsTheFinalRecord() {
        val rows = listOf(checkIn to "done", activity("merchandising", start + 1) to "done")
        assertNull(VisitCompletion.result(checkIn.clientVisitId, rules, rows, null))
        val endAt = start + 25 * 60_000
        val queued = rows + (end("completed", null, fix(endAt, 12), endAt) to "pending")
        val result = VisitCompletion.result(checkIn.clientVisitId, rules, queued, null)!!
        assertEquals("completed", result.outcome)
        assertEquals(25, result.minutes)
        assertEquals(listOf("merchandising"), result.recorded)
        assertEquals(listOf("future_form"), result.officeReview)
        assertEquals("End location recorded · ±12 m", result.location)
        assertFalse(result.locationReview)
        assertEquals("Waiting to send", result.sync)
        val accepted = rows + (queued.last().first to "done")
        assertEquals("Accepted", VisitCompletion.result(checkIn.clientVisitId, rules, accepted, null)!!.sync)
    }

    @Test fun missingOrWeakEndLocationIsFlaggedNotRefused() {
        val rows = listOf(checkIn to "done")
        val noFix = VisitCompletion.result(checkIn.clientVisitId, rules,
            rows + (end("nonproductive", "closed", null, start + 1) to "pending"), null)!!
        assertTrue(noFix.locationReview)
        assertEquals("End location unavailable · supervisor will review", noFix.location)
        assertEquals("closed", noFix.reasonCode)
        assertTrue(noFix.officeReview.isEmpty()) // not productive: no forms owed
        val weak = VisitCompletion.result(checkIn.clientVisitId, rules,
            rows + (end("nonproductive", "closed", fix(start + 1, 400), start + 1) to "pending"), null)!!
        assertTrue(weak.locationReview)
        assertTrue(weak.location.contains("weak signal"))
    }

    @Test fun nothingCanBeAddedAfterEndUnlessTheServerRejectedIt() {
        val ended = end("nonproductive", "closed", null, start + 2)
        val late = activity("note", start + 3)
        val rows = listOf(checkIn to "done", ended to "pending")
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, assertThrows(VisitRuleFailure::class.java) {
            VisitCompletion.requireOpenForActivity(late, rows) }.code)
        VisitCompletion.requireOpenForActivity(late, listOf(checkIn to "done", ended to "review"))
        VisitCompletion.requireOpenForActivity(late, listOf(checkIn to "done"))
        VisitCompletion.requireOpenForActivity(ended, rows) // End itself is owned by VisitCallRules
    }
}
