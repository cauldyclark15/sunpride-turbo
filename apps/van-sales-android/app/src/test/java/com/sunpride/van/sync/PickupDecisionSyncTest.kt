package com.sunpride.van.sync

import com.sunpride.van.pos.PickupDecision
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** r6van3: the office's decision on a return held for approval reaches the phone in the bundle and replaces "Waiting for office approval". */
class PickupDecisionSyncTest {
    private fun fixture() = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().use { it.readText() }
    private val held = "6f1c2b9e-7a3d-4c1e-9b2a-0d4e5f6a7b8c"
    private val other = "0b6a9e3c-2d1f-4e5a-8c7b-1a2b3c4d5e6f"

    @Test fun bundleCarriesTheOfficeDecisionOutsideTheFrozenValidator() {
        assertNull("older server: not said", VanBootstrapCodec.decode(fixture()).policy.pickupDecisions)
        val o = JSONObject(fixture())
        o.getJSONObject("policy").put("pickupDecisions", JSONArray()
            .put(JSONObject().put("returnId", held).put("decision", "disposal_verified").put("reason", "Checked with the store").put("decidedAt", 1_700_000_000_000L))
            .put(JSONObject().put("returnId", other).put("decision", "returned_to_outlet").put("reason", "No proof of disposal").put("decidedAt", 1_700_000_000_001L))
            .put(JSONObject().put("returnId", "x").put("decision", "something_new")))
        val decisions = VanBootstrapCodec.decode(o.toString()).policy.pickupDecisions!!
        assertEquals(setOf(held, other), decisions.keys)
        assertTrue(decisions.getValue(held).approved)
        assertFalse(decisions.getValue(other).approved)
        // the raw policy JSON the phone caches decodes the same way
        assertEquals(decisions, VanBootstrapCodec.policy(o.getJSONObject("policy")).pickupDecisions)
    }

    @Test fun savedReturnScreenResolvesTheOutcome() {
        assertEquals("Waiting for office approval", PickupDecision.title(null))
        val ok = PickupDecision(held, PickupDecision.DISPOSAL_VERIFIED, "Checked with the store", 1L)
        assertEquals("Office verified the disposal", PickupDecision.title(ok))
        assertTrue(PickupDecision.detail(ok).contains("Reason: Checked with the store"))
        val no = PickupDecision(other, PickupDecision.RETURNED_TO_OUTLET, "No proof of disposal", 1L)
        assertEquals("Office rejected the return", PickupDecision.title(no))
        assertTrue(PickupDecision.detail(no).startsWith("Reason: No proof of disposal"))
        assertTrue(PickupDecision.detail(no).contains("Nothing was added to the truck stock"))
    }
}
