package com.sunpride.field.ui.truckstock

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0227: the Saturday count is checked against what was actually loaded, and differences carry a reason. */
class TruckStockTest {
    private fun line(id: String, requested: Long, served: Long, sold: Long, extra: Boolean = false) = JSONObject()
        .put("productId", id).put("name", "SAMPLE $id").put("code", id).put("uom", "PC")
        .put("requestedBase", requested).put("servedBase", served).put("soldBase", sold)
        .put("countedBase", JSONObject.NULL).put("reasonId", JSONObject.NULL).put("note", JSONObject.NULL)
        .apply { if (extra) put("notLoaded", true) }
    private val data = JSONObject()
        .put("week", JSONObject().put("id", "w1").put("weekStart", "2026-11-16").put("status", "open")
            .put("lines", JSONArray().put(line("a", 100, 80, 48)).put(line("b", 20, 20, 20)).put(line("c", 0, 0, 3, extra = true))))
        .put("reasons", JSONArray().put(JSONObject().put("id", "missing").put("name", "Missing")))

    @Test fun decodesLoadedLinesOnly() {
        val week = TruckStock.decode(data)!!
        assertEquals(listOf("a", "b"), week.lines.map { it.productId })
        assertEquals(32, week.lines[0].expectedLeft)
        assertEquals(20, week.lines[0].short)
        assertNull(TruckStock.decode(JSONObject().put("week", JSONObject.NULL)))
    }

    @Test fun missingReasonFlagsOnlyUnexplainedLines() {
        val week = TruckStock.decode(data)!!
        val counts = mapOf("a" to "30", "b" to "0")
        assertEquals(listOf("a"), TruckStock.missingReasons(week, counts, emptyMap()))
        assertEquals(emptyList<String>(), TruckStock.missingReasons(week, counts, mapOf("a" to "missing")))
        assertEquals("Choose a reason for every stock difference.", TruckStock.REASON_MISSING)
    }

    @Test fun differenceUsesLoadedNotRequested() {
        val a = TruckStock.decode(data)!!.lines[0]
        assertEquals("2 missing", TruckStock.difference(a, 30))
        assertEquals("Balanced", TruckStock.difference(a, 32))
        assertEquals("1 extra", TruckStock.difference(a, 33))
        assertTrue(TruckStock.needsReason(a, 30))
        val b = TruckStock.decode(data)!!.lines[1]
        assertFalse(TruckStock.needsReason(b, 0))
    }

    @Test fun balancedLeftoverNeedsNoReason() {
        val week = TruckStock.decode(data)!!
        assertFalse(TruckStock.needsReason(week.lines[0], 32))
        val p = TruckStock.payload(week, mapOf("a" to "32", "b" to "0"), emptyMap(), emptyMap())
        assertTrue(p.getJSONArray("lines").getJSONObject(0).isNull("reasonId"))
    }

    @Test fun payloadRequiresEveryCountAndReasons() {
        val week = TruckStock.decode(data)!!
        val missingCount = runCatching { TruckStock.payload(week, mapOf("a" to "30"), emptyMap(), emptyMap()) }
        assertTrue(missingCount.isFailure)
        val noReason = runCatching { TruckStock.payload(week, mapOf("a" to "30", "b" to "0"), emptyMap(), emptyMap()) }
        assertEquals("Choose a reason for SAMPLE a", noReason.exceptionOrNull()?.message)
        val p = TruckStock.payload(week, mapOf("a" to "30", "b" to "0"), mapOf("a" to "missing"), mapOf("a" to " two short "))
        assertEquals("w1", p.getString("weekId"))
        val lines = p.getJSONArray("lines")
        assertEquals(2, lines.length())
        assertEquals(30, lines.getJSONObject(0).getLong("countedBase"))
        assertEquals("missing", lines.getJSONObject(0).getString("reasonId"))
        assertEquals("two short", lines.getJSONObject(0).getString("note"))
        assertTrue(lines.getJSONObject(1).isNull("reasonId"))
        assertTrue(runCatching { TruckStock.payload(week, mapOf("a" to "1.5", "b" to "0"), mapOf("a" to "missing"), emptyMap()) }.isFailure)
    }
}
