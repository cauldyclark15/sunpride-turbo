package com.sunpride.van.sync

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class VanBootstrapCodecTest {
    private fun fixture(name: String = "bootstrap-response.json") = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
    @Test fun frozenBootstrapIncludesTypedTripProductsCustomersAndPolicy() {
        val b = VanBootstrapCodec.decode(fixture())
        assertEquals("2026-10-07",b.serviceDate); assertEquals("loading",b.trip!!.status)
        assertEquals(48L,b.load!!.lines.first().expectedBase); assertNull(b.load.lines.first().actualBase)
        assertFalse(b.policy.allowNegativeStock); assertTrue(b.policy.walkInAllowed)
        assertEquals(listOf("4800000000017"),b.products.first().barcodes)
        assertEquals(3,b.customers.size); assertEquals("unplanned",b.customers.last().source)
    }
    @Test fun debugFixtureIsExactlyTheFrozenFixtureReadInPlace() { assertEquals(JSONObject(fixture()).toString(),JSONObject(FakeVanBackend.FIXTURE).toString()) }
    @Test fun frozenNoTripIsValidEmptyState() {
        val b = VanBootstrapCodec.decode(fixture("bootstrap-no-trip-response.json")); assertNull(b.trip); assertNull(b.load); assertTrue(b.truckStock.isEmpty())
    }
    @Test fun strictEnumsTypesMissingNullsBoundsAndExtraFieldsAreRejected() {
        val mutations: List<(JSONObject)->Unit> = listOf(
            { it.put("extra",1) }, { it.remove("trip") }, { it.put("contractVersion",2) },
            { it.getJSONObject("trip").put("status","flying") },
            { it.getJSONObject("policy").put("allowNegativeStock","false") },
            { it.getJSONArray("products").getJSONObject(0).put("quantityScale",1) },
            { it.getJSONArray("products").getJSONObject(0).put("quantityScale","0") },
            { it.getJSONObject("load").getJSONArray("lines").getJSONObject(0).remove("actualBase") },
            { it.getJSONObject("load").getJSONArray("lines").getJSONObject(0).put("expectedBase","9999999999999999999") },
            { it.getJSONObject("trip").put("serviceDate","2026-10-08") }
        )
        mutations.forEach { change -> val o = JSONObject(fixture()); change(o); assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) } }
    }
    @Test fun signedNegativeBalanceAndLargeIntegersHaveNoDoubleRounding() {
        val o = JSONObject(fixture()); val id = o.getJSONArray("products").getJSONObject(0).getString("productId")
        o.getJSONArray("truckStock").put(JSONObject().put("productId",id).put("availableBase","-9007199254740993").put("damagedBase","9007199254740995"))
        val b = VanBootstrapCodec.decode(o.toString()); assertEquals(-9007199254740993L,b.truckStock.single().availableBase); assertEquals(9007199254740995L,b.truckStock.single().damagedBase)
    }
    @Test fun persistedOperationBytesAreConcatenatedWithoutReserialization() {
        val op = """{ "kind":"trip.start", "clientRequestId":"10000000-0000-4000-8000-000000000001", "payload":{"tripId":"t","vehicleConfirmed":true,"routeConfirmed":true,"deviceTime":1} }"""
        val body = String(VanBootstrapCodec.pushRequest("d",listOf(op)))
        assertTrue(body.contains(op)); assertThrows(IllegalArgumentException::class.java) { VanBootstrapCodec.pushRequest("d",List(21) { op }) }
    }
    @Test fun frozenPushResultsAndErrorsDecodeWithoutDisplayingServerMessages() {
        val text = fixture("push-response.json"); assertTrue(VanBootstrapCodec.pushResults(text).isNotEmpty())
        val error = VanSyncClient.error(429,"""{"type":"error.response","contractVersion":1,"code":"temporarily_unavailable","message":"secret","retryable":true}""")
        assertTrue(error.retryable); assertFalse(error.toString().contains("secret"))
    }
}
