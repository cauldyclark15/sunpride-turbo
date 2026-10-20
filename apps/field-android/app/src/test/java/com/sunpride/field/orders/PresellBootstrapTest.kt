package com.sunpride.field.orders

import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.sync.WireFailure
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class PresellBootstrapTest {
    private fun unplanned(v2: Boolean = true): JSONObject {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
            .bufferedReader().use { it.readText() }
        return JSONObject(text).put("plannedVisits", JSONArray())
            .put("nextPageCursor", JSONObject.NULL).put("syncCursor", "opaque-final-cursor")
            .also { if (v2) it.put("v2SnapshotId", "presell-unplanned-snapshot") }
    }

    @Test fun `F-301 v2 assigned outlet retains its call sheet without a planned visit`() {
        val page = BootstrapCodec.page(unplanned().toString())
        val snapshot = BootstrapCodec.snapshot(listOf(page))
        assertTrue(snapshot.visits.isEmpty())
        assertEquals("outlet-1", snapshot.outlets.single().id)
        assertEquals("outlet-1", snapshot.callSheets.single().outletId)
    }

    @Test fun `F-301 v2 refuses call sheets outside the authorized outlet snapshot`() {
        val raw = unplanned().also {
            it.getJSONArray("callSheets").getJSONObject(0).put("outletId", "foreign-outlet")
        }
        val page = BootstrapCodec.page(raw.toString())
        assertThrows(IllegalArgumentException::class.java) { BootstrapCodec.snapshot(listOf(page)) }
    }

    @Test fun `F-301 legacy v1 does not acquire unplanned call sheet authority`() {
        assertThrows(WireFailure::class.java) { BootstrapCodec.page(unplanned(false).toString()) }
    }
}
