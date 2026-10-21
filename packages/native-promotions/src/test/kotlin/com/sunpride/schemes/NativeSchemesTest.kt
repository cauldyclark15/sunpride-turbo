package com.sunpride.schemes

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class NativeSchemesTest {
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(prefix = "{", postfix = "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(prefix = "[", postfix = "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }
    @Test fun f502F503CanonicalMechanicsStackingAndEligibility() {
        val text = checkNotNull(javaClass.getResourceAsStream("/scheme-v1-parity.json")).bufferedReader().use { it.readText() }
        val fixtures = JSONArray(text)
        for (i in 0 until fixtures.length()) {
            val row = fixtures.getJSONObject(i)
            assertEquals("F-502/F-503 " + row.getString("name"), canonical(row.getJSONObject("expected")), canonical(NativeSchemes.quote(row.getJSONObject("request"))))
        }
    }
    @Test fun f502UnknownEngineDoesNotInventAQuote() {
        assertThrows(IllegalStateException::class.java) { NativeSchemes.quote(JSONObject().put("engineVersion", 99)) }
    }
}
