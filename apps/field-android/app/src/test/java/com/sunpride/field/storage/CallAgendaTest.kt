package com.sunpride.field.storage

import com.sunpride.field.ui.plannedVisitDisplay
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CallAgendaTest {
    private fun agenda() = JSONObject("""{"asOfDate":"2026-10-20","beat":"North Cebu","planVersion":3,
      "objectives":["Review shelf gaps","Collect overdue invoice"],"lastVisit":{"date":"2026-10-19","outcome":"completed"},
      "ar":{"status":"sample","amountMinor":12345,"source":"Sample office AR snapshot","asOfDate":"2026-10-19"},
      "msl":{"status":"known","source":"Sample","version":"v1","asOfDate":"2026-10-19","requiredCount":3,
      "gaps":[{"productId":"p1","code":"CB","name":"Sample corned beef","status":"out_of_stock"}],
      "unmeasured":[{"productId":"p2","code":"BF","name":"Sample beef loaf","status":"unmeasured"}]}}""")

    @Test fun `F-203 objectives and gaps survive the encrypted snapshot DTO`() {
        val raw = JSONObject().put("id","plan-1").put("outletId","o1").put("intents",org.json.JSONArray())
            .put("agenda",agenda())
        val row = SnapshotItem("plan-1",raw.toString(),"2026-10-20",0)
        val decoded = plannedVisitDisplay(row, mapOf("o1" to JSONObject().put("name","Corner store")), emptyMap())
        assertEquals(listOf("Review shelf gaps","Collect overdue invoice"),decoded.agenda!!.objectives)
        assertEquals(listOf("Sample corned beef"),decoded.agenda!!.gaps)
        assertEquals(1,decoded.agenda!!.unmeasured)
        assertEquals("2026-10-19 · Completed",decoded.agenda!!.lastVisit)
        assertTrue(decoded.agenda!!.arLabel.contains("123.45"))
        assertTrue(decoded.agenda!!.arLabel.contains("sample"))
    }
    @Test fun `F-203 unknown AR is not zero and missing MSL is not complete`() {
        val raw=agenda()
        raw.getJSONObject("ar").put("status","unavailable").put("amountMinor",JSONObject.NULL)
        raw.getJSONObject("msl").put("status","needs_setup").put("requiredCount",JSONObject.NULL)
        val decoded=CallAgenda.decode(raw)
        assertEquals("Not supplied by SAP",decoded.arLabel)
        assertFalse(decoded.mslKnown)
        assertNull(decoded.required)
    }
    @Test fun `F-203 invalid money version and objectives are refused before promotion`() {
        val raw=agenda(); raw.getJSONObject("ar").put("amountMinor",1.5)
        assertThrows(IllegalArgumentException::class.java) { CallAgenda.decode(raw) }
        assertThrows(IllegalArgumentException::class.java) { CallAgenda.decode(agenda().put("planVersion",1.5)) }
        assertThrows(IllegalArgumentException::class.java) { CallAgenda.decode(agenda().put("planVersion",4_294_967_297L)) }
        val big=agenda().put("objectives",org.json.JSONArray((0..50).map { "Objective $it" }))
        assertThrows(IllegalArgumentException::class.java) { CallAgenda.decode(big) }
    }
    @Test fun `F-203 older servers do not invent agenda facts`() {
        val row=SnapshotItem("p","""{"id":"p","outletId":"o","intents":[]}""","2026-10-20",0)
        assertNull(plannedVisitDisplay(row,emptyMap(),emptyMap()).agenda)
    }
}
