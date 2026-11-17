package com.sunpride.field.sell

import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0192: Selling is off unless the server says exactly true; an older server (no key) keeps today's app. */
class SellingFlagTest {
    @Test fun onlyAnExplicitTrueSwitchesSellingOn() {
        assertFalse(SellingFlag.from(null))
        assertFalse(SellingFlag.from(JSONObject()))
        assertFalse(SellingFlag.from(JSONObject().put("selling", false)))
        assertFalse(SellingFlag.from(JSONObject().put("selling", JSONObject.NULL)))
        assertFalse(SellingFlag.from(JSONObject().put("selling", "true")))
        assertFalse(SellingFlag.from(JSONObject().put("selling", 1)))
        assertTrue(SellingFlag.from(JSONObject().put("selling", true)))
        assertTrue(SellingFlag.from(JSONObject().put("profile", JSONObject().put("selling", true))))
        assertFalse(SellingFlag.from(JSONObject().put("profile", JSONObject().put("selling", false))))
    }

    @Test fun anOldStyleMeAnswerStillParses() {
        val me = JSONObject().put("version", 2).put("profile", JSONObject().put("id", "p").put("subject", "s").put("active", true))
            .put("scope", JSONObject().put("id", "u").put("fingerprint", "f").put("epoch", "1"))
        assertFalse(SellingFlag.from(me))
        assertTrue(SellingFlag.from(JSONObject(me.toString()).put("selling", true).put("somethingNew", JSONObject())))
    }
}
