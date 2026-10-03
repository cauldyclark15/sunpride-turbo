package com.sunpride.field.storage

import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import com.sunpride.field.ui.diagnosticvisit.captureOrNull
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class VisitCallRulesTest {
    private val scope = StoreScope("a", "d", "s")
    private val at = Instant.parse("2026-10-02T02:00:00Z").toEpochMilli()
    private val day = "2026-10-02"
    private fun plan(id: String, sequence: Int? = null) = SnapshotItem(id,
        JSONObject().put("outletId", id).apply { sequence?.let { put("sequence", it) } }.toString(), day)
    private fun start(id: String, planned: Boolean = true, time: Long = at, location: JSONObject? = null) =
        VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, if (planned) id else null,
            id, emptyList(), "Customer request", null, null, null, location, time)
    private fun end(start: IntentRow, outcome: String? = "completed", reason: String? = null, time: Long = at + 24 * 60_000) =
        VisitIntentFactory.create(scope, "visit.checkOut", start.clientVisitId, start.requestId, start.requestId,
            null, "", emptyList(), null, null, outcome, reason, null, time)
    private fun failure(code: VisitRuleFailure.Code, block: () -> Unit) =
        assertEquals(code, assertThrows(VisitRuleFailure::class.java, block).code)

    @Test fun sequenceSortAndAbsentFallbackAreStable() {
        assertEquals(listOf("z", "a"), VisitCallRules.ordered(listOf(plan("z"), plan("a"))).map { it.id })
        assertEquals(listOf("a", "z"), VisitCallRules.ordered(listOf(plan("z", 2), plan("a", 0))).map { it.id })
        assertEquals(listOf("z", "a"), VisitCallRules.ordered(listOf(plan("z", 0), plan("a", 0))).map { it.id })
    }
    @Test fun earlierPlanMustBeClosedWithProductivityAndQueuedEndUnlocksNext() {
        val plans = listOf(plan("b", 2), plan("a", 0))
        failure(VisitRuleFailure.Code.MCP_ORDER) { VisitCallRules.requireStart("b", "b", day, plans, emptyList()) }
        val a = start("a")
        for (state in listOf("pending", "sending", "done")) {
            failure(VisitRuleFailure.Code.CALL_OPEN) { VisitCallRules.requireStart("b", "b", day, plans, listOf(a to state)) }
        }
        val rows = listOf(a to "done", end(a) to "pending")
        VisitCallRules.requireStart("b", "b", day, plans, rows)
        assertEquals("24 min", VisitCallRules.timeSpent(rows))
    }
    @Test fun absentSequenceStillEnforcesOriginalListOrder() {
        failure(VisitRuleFailure.Code.MCP_ORDER) {
            VisitCallRules.requireStart("a", "a", day, listOf(plan("z"), plan("a")), emptyList())
        }
    }
    @Test fun equalExplicitSequenceDoesNotAddAnOrderRestriction() {
        VisitCallRules.requireStart("b", "b", day, listOf(plan("a", 0), plan("b", 0)), emptyList())
    }
    @Test fun unplannedOnlyNeedsNoOpenCallAndDaysAreIsolated() {
        VisitCallRules.requireStart(null, "c", day, listOf(plan("a", 0)), emptyList())
        val a = start("a")
        failure(VisitRuleFailure.Code.CALL_OPEN) { VisitCallRules.requireStart(null, "c", day, emptyList(), listOf(a to "pending")) }
        VisitCallRules.requireStart(null, "c", "2026-10-03", emptyList(), listOf(a to "pending"))
    }
    @Test fun rejectedEndNeverClosesCallAndRejectedStartNeverUnlocksPlan() {
        val a = start("a")
        failure(VisitRuleFailure.Code.CALL_OPEN) {
            VisitCallRules.requireStart("b", "b", day, listOf(plan("a", 0), plan("b", 1)), listOf(a to "done", end(a) to "review"))
        }
        failure(VisitRuleFailure.Code.MCP_ORDER) {
            VisitCallRules.requireStart("b", "b", day, listOf(plan("a", 0), plan("b", 1)), listOf(a to "review"))
        }
    }
    @Test fun endRequiresOutcomeAndNonproductiveReasonAndCannotEndTwice() {
        val a = start("a")
        failure(VisitRuleFailure.Code.OUTCOME_REQUIRED) { end(a, null) }
        failure(VisitRuleFailure.Code.REASON_REQUIRED) { end(a, "nonproductive") }
        val nonproductive = end(a, "nonproductive", "other")
        assertTrue(VisitCallRules.closed(listOf(a to "pending", nonproductive to "pending")))
        failure(VisitRuleFailure.Code.ALREADY_ENDED) {
            VisitCallRules.requireEnd(a.clientVisitId, JSONObject(nonproductive.serializedOperation).getJSONObject("payload"),
                listOf(a to "pending", nonproductive to "pending"))
        }
    }
    @Test fun farOrInaccurateLocationIsRecordedWithoutGatingAndMissingFixIsExplicitNull() = runBlocking {
        val fix = JSONObject().put("latitude", 0).put("longitude", 0).put("accuracyMeters", 9000)
            .put("fixTime", at).put("provider", "gps").put("mockSignal", true)
        val a = start("a", location = fix)
        assertEquals(fix.toString(), JSONObject(a.serializedOperation).getJSONObject("payload").getJSONObject("location").toString())
        assertTrue(JSONObject(start("b").serializedOperation).getJSONObject("payload").isNull("location"))
        val failed = object : VisitLocation { override suspend fun fix(): JSONObject? = throw SecurityException() }
        assertNull(failed.captureOrNull())
        val timeout = object : VisitLocation { override suspend fun fix(): JSONObject? = null }
        assertNull(timeout.captureOrNull())
    }
    @Test fun serviceDateComesFromDeviceTimeNotWallClock() {
        val a = start("a", time = Instant.parse("2026-10-01T16:00:00Z").toEpochMilli())
        assertEquals(day, JSONObject(a.serializedOperation).getJSONObject("payload").getString("serviceDate"))
    }
}
