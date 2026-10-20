package com.sunpride.field.storage

import com.sunpride.field.ui.plannedVisitDisplay
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ServerVisitsTest {
    private fun plan(id: String, sequence: Int) = SnapshotItem(id, JSONObject().put("id",id).put("outletId","outlet-$id")
        .put("serviceDate","2026-10-20").put("sequence",sequence).put("intents",JSONArray()).toString(), "2026-10-20")
    private fun call(id: String, state: String = "checked-out") = JSONObject().put("id","execution-$id")
        .put("plannedVisitId",id).put("outletId","outlet-$id").put("serviceDate","2026-10-20").put("state",state)
    private fun page(vararg calls: JSONObject) = JSONObject().put("visitExecutions",JSONArray(calls.toList()))
    @Test fun midDayBootstrapCountsPriorCallsAndAllowsNextStopWithoutInventingOutboxRows() {
        val plans=ServerVisits.attach(listOf(plan("1",0),plan("2",1)),listOf(page(call("1"))))
        assertTrue(ServerVisits.closed(plans[0]))
        assertEquals("Done",plannedVisitDisplay(plans[0],emptyMap(),emptyMap()).status)
        assertNull(VisitCallRules.startFailure("2","outlet-2","2026-10-20",plans,emptyList()))
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED,
            VisitCallRules.startFailure("1","outlet-1","2026-10-20",plans,emptyList())?.code)
    }
    @Test fun executionsOnAnotherPageStillMatchAndForeignStoreOrDayFailsClosed() {
        val plans=ServerVisits.attach(listOf(plan("1",0)),listOf(page(),page(call("1"))))
        assertTrue(ServerVisits.closed(plans[0]))
        assertTrue(runCatching { ServerVisits.attach(listOf(plan("1",0)),listOf(page(call("1").put("outletId","foreign")))) }.isFailure)
        assertTrue(runCatching { ServerVisits.attach(listOf(plan("1",0)),listOf(page(call("1").put("serviceDate","2026-10-19")))) }.isFailure)
        assertTrue(runCatching { ServerVisits.attach(listOf(plan("1",0)),listOf(page(call("1"),call("1")))) }.isFailure)
    }
    @Test fun openCallStillBlocksStartingAnotherStoreAndMissingExtensionKeepsOldBehavior() {
        val plans=ServerVisits.attach(listOf(plan("1",0),plan("2",1)),listOf(page(call("1","in-progress"))))
        assertEquals(VisitRuleFailure.Code.CALL_OPEN,
            VisitCallRules.startFailure("2","outlet-2","2026-10-20",plans,emptyList())?.code)
        val legacy=ServerVisits.attach(listOf(plan("1",0),plan("2",1)),emptyList())
        assertEquals(VisitRuleFailure.Code.MCP_ORDER,
            VisitCallRules.startFailure("2","outlet-2","2026-10-20",legacy,emptyList())?.code)
    }
}
