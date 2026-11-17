package com.sunpride.field.ui

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0195: the App mode read from the Field app's own `/api/me`, with a safe fallback for older servers. */
class AppModeTest {
    private fun me(profile: JSONObject) = JSONObject().put("profile", profile)

    @Test fun readsTheOfficesModeAndTheOwnersModes() {
        assertEquals(AppModes(AppMode.MAPPING), AppModes.from(me(JSONObject().put("appMode", "mapping").put("selling", false))))
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(me(JSONObject().put("appMode", "visits"))))
        val owner = AppModes.from(me(JSONObject().put("appMode", "selling").put("selling", true)
            .put("modes", JSONArray(listOf("mapping", "visits", "selling")))))
        assertEquals(AppMode.SELLING, owner.mode)
        assertEquals(AppMode.entries.toList(), owner.modes)
        assertTrue(owner.canSwitch)
        assertFalse(AppModes.from(me(JSONObject().put("appMode", "visits").put("modes", JSONArray(listOf("visits"))))).canSwitch)
    }

    @Test fun missingOrUnknownModeFallsBackOnTheSellingFlag() {
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(null))
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(JSONObject()))
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(me(JSONObject().put("selling", false))))
        assertEquals(AppModes(AppMode.SELLING), AppModes.from(me(JSONObject().put("selling", true))))
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(me(JSONObject().put("appMode", "census"))))
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(me(JSONObject().put("appMode", JSONObject.NULL))))
        assertEquals(AppModes(AppMode.VISITS), AppModes.from(me(JSONObject().put("appMode", 3))))
        // Unknown entries in modes are dropped; the person's own mode is always in the list.
        val odd = AppModes.from(me(JSONObject().put("appMode", "mapping").put("modes", JSONArray(listOf("boss", 7, "visits")))))
        assertEquals(listOf(AppMode.MAPPING, AppMode.VISITS), odd.modes)
        val notArray = AppModes.from(me(JSONObject().put("appMode", "mapping").put("modes", "all")))
        assertEquals(listOf(AppMode.MAPPING), notArray.modes)
    }

    @Test fun keptOnThePhoneAndReadBack() {
        val owner = AppModes(AppMode.SELLING, AppMode.entries.toList())
        assertEquals(owner, AppModes.decode(owner.encode(), selling = true))
        assertEquals(AppModes(AppMode.MAPPING), AppModes.decode(AppModes(AppMode.MAPPING).encode(), selling = true))
        // Nothing saved yet (older server, first launch): the Selling flag decides, as before.
        assertEquals(AppModes(AppMode.SELLING), AppModes.decode(null, selling = true))
        assertEquals(AppModes(AppMode.VISITS), AppModes.decode("garbage", selling = false))
    }

    @Test fun theOwnersChoiceOnlyPicksAnAllowedModeAndSellingNeedsTheSellingSwitch() {
        val owner = AppModes(AppMode.SELLING, AppMode.entries.toList())
        assertEquals(AppMode.SELLING, owner.effective(null, sells = true))
        assertEquals(AppMode.MAPPING, owner.effective(AppMode.MAPPING, sells = true))
        val salesman = AppModes(AppMode.MAPPING)
        assertEquals("a remembered choice outside the allowed modes is ignored", AppMode.MAPPING,
            salesman.effective(AppMode.SELLING, sells = true))
        assertEquals("Truck selling without Selling shows Field visits", AppMode.VISITS,
            AppModes(AppMode.SELLING).effective(null, sells = false))
    }
}
