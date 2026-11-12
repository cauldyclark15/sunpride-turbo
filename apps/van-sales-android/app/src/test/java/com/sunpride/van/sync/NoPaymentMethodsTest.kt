package com.sunpride.van.sync

import com.sunpride.van.ui.UserMessages
import com.sunpride.van.vanday.DayFacts
import com.sunpride.van.vanday.VanDaySteps
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** NF-R5V-5: a bundle whose unit has no payment methods says so, instead of "paused until the office confirms this phone". */
class NoPaymentMethodsTest {
    private fun fixture() = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().use { it.readText() }

    @Test fun emptyPaymentMethodListIsANamedSetupGapNotABrokenResponse() {
        val o = JSONObject(fixture()); o.getJSONObject("policy").put("paymentMethods", JSONArray())
        val failure = runCatching { VanBootstrapCodec.decode(o.toString()) }.exceptionOrNull()
        assertTrue("got $failure", failure is VanSyncFailure)
        assertEquals("no_payment_methods", (failure as VanSyncFailure).code)
        assertFalse(failure.retryable)
        val words = UserMessages.forCode(failure.code)
        assertNotNull(words)
        assertTrue(words!!.contains("payment methods") && words.contains("office"))
        assertFalse(words.contains("confirms this phone"))
        // The good bundle still decodes.
        assertTrue(VanBootstrapCodec.decode(fixture()).policy.paymentMethods.isNotEmpty())
    }

    @Test fun todayNamesTheSetupGapInsteadOfTheGenericHold() {
        val words = UserMessages.forCode("no_payment_methods")!!
        val facts = DayFacts(false, null, false, null, false, null, false, false, false, false, false, null, 0, true, setupProblem = words)
        assertEquals(words, VanDaySteps.next(facts).detail)
        assertTrue(VanDaySteps.holdText(words).startsWith(words))
        assertTrue(VanDaySteps.holdText(null).contains("confirms this phone"))
    }
}
