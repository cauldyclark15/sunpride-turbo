package com.sunpride.van.sync

import com.sunpride.van.data.*
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
        assertEquals(listOf("4800000000017","14800000000016"),b.products.first().barcodes)
        assertEquals(listOf(BarcodeUnit("4800000000017","PC",1),BarcodeUnit("14800000000016","CS",24)),b.products.first().barcodeUnits)
        assertTrue("barcodeUnits is optional",b.products.last().barcodeUnits.isEmpty())
        assertEquals(3,b.customers.size); assertEquals("unplanned",b.customers.last().source)
        // VAN-012: office payment methods and per-customer credit terms.
        assertEquals(listOf("cash","check","gcash","bank_transfer","credit"),b.policy.paymentMethods.map { it.code })
        assertEquals(PaymentMethod("check","Check",PaymentKind.OTHER,true,"Check number"),b.policy.paymentMethods[1])
        assertEquals(CustomerCredit(30,500_000),b.customers[0].credit); assertNull(b.customers[1].credit); assertNull(b.customers[2].credit)
    }
    @Test fun frozenDamagePolicyHistoryAndEvidenceEnvelopesDecode() {
        val b = VanBootstrapCodec.decode(fixture())
        assertEquals(DamagePolicy(listOf("crushed","leaking","spoiled","other"),12,90_000),b.policy.damagePolicy)
        val record = b.damageRecords.single()
        assertEquals("recorded",record.status); assertEquals(2L,record.quantityBase); assertNull(record.decisionNote)
        assertEquals("PC",record.uomCode); assertEquals(1L,record.quantityScale); assertEquals("2 PC",record.quantityLabel)
        // Release-check counterexample: the product's unit later changes; history keeps the recorded unit.
        val renewed = JSONObject(fixture())
        VanBootstrapCodec.objects(renewed.getJSONArray("products")).first().put("uomCode","EACH").put("quantityScale","1000")
        renewed.getJSONArray("damageRecords").getJSONObject(0).put("uomCode","CASE").put("quantityScale","1000").put("quantityBase","12000")
        assertEquals("12 CASE",VanBootstrapCodec.decode(renewed.toString()).damageRecords.single().quantityLabel)
        // A record without its frozen unit is not accepted.
        val unfrozen = JSONObject(fixture()); unfrozen.getJSONArray("damageRecords").getJSONObject(0).remove("uomCode")
        assertTrue(runCatching { VanBootstrapCodec.decode(unfrozen.toString()) }.isFailure)
        val request = JSONObject(fixture("evidence-request.json")); VanWireSchema.validate(request)
        val jpeg = java.util.Base64.getDecoder().decode(request.getString("dataBase64"))
        val encoded = VanEvidenceCodec.request(request.getString("deviceId"),request.getString("sha256"),jpeg)
        assertEquals(request.toString(),JSONObject(String(encoded)).toString())
        VanEvidenceCodec.response(fixture("evidence-response.json"),request.getString("sha256"))
    }
    @Test fun oldBootstrapHasNoDamagePhotoOrApprovalRequirement() {
        val o = JSONObject(fixture()); o.getJSONObject("policy").remove("damagePolicy"); o.remove("damageRecords")
        val b = VanBootstrapCodec.decode(o.toString()); assertNull(b.policy.damagePolicy); assertTrue(b.damageRecords.isEmpty())
    }
    @Test fun wireCopyMatchesCommittedAuthority() {
        assertEquals(JSONObject(fixture("van-v1.schema.json")).toString(),JSONObject(VanWireSchema.SCHEMA).toString())
    }
    @Test fun policyAndCustomersWithoutPaymentFieldsAllowCashOnly() {
        val o = JSONObject(fixture()); o.getJSONObject("policy").remove("paymentMethods"); o.getJSONArray("customers").getJSONObject(0).remove("credit")
        val b = VanBootstrapCodec.decode(o.toString())
        assertEquals(PaymentMethod.CASH_ONLY,b.policy.paymentMethods); assertNull(b.customers[0].credit)
        assertEquals(PaymentMethod.CASH_ONLY,VanBootstrapCodec.decode(fixture("bootstrap-no-trip-response.json")).policy.paymentMethods)
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
            // VAN-009: a unit for a barcode the product does not carry, a duplicate, or a zero/float scan quantity.
            { it.getJSONArray("products").getJSONObject(0).getJSONArray("barcodeUnits").getJSONObject(1).put("barcode","999") },
            { it.getJSONArray("products").getJSONObject(0).getJSONArray("barcodeUnits").getJSONObject(1).put("barcode","4800000000017") },
            { it.getJSONArray("products").getJSONObject(0).getJSONArray("barcodeUnits").getJSONObject(1).put("baseQuantity","0") },
            { it.getJSONArray("products").getJSONObject(0).getJSONArray("barcodeUnits").getJSONObject(1).put("baseQuantity","2.5") },
            { it.getJSONObject("load").getJSONArray("lines").getJSONObject(0).remove("actualBase") },
            { it.getJSONObject("load").getJSONArray("lines").getJSONObject(0).put("expectedBase","9999999999999999999") },
            { it.getJSONObject("trip").put("serviceDate","2026-10-08") },
            // VAN-012: unknown kind, duplicate code, empty list, a reference on cash, bad terms or a float credit amount.
            { it.getJSONObject("policy").getJSONArray("paymentMethods").getJSONObject(1).put("kind","voucher") },
            { it.getJSONObject("policy").getJSONArray("paymentMethods").getJSONObject(1).put("code","cash") },
            { it.getJSONObject("policy").put("paymentMethods",org.json.JSONArray()) },
            { it.getJSONObject("policy").getJSONArray("paymentMethods").getJSONObject(0).put("referenceRequired",true) },
            { it.getJSONArray("customers").getJSONObject(0).getJSONObject("credit").put("termsDays",0) },
            { it.getJSONArray("customers").getJSONObject(0).getJSONObject("credit").put("termsDays",181) },
            { it.getJSONArray("customers").getJSONObject(0).getJSONObject("credit").put("availableMinor","10.5") },
            { it.getJSONObject("policy").getJSONObject("damagePolicy").put("approvalFromUnits",0) },
            { it.getJSONObject("policy").getJSONObject("damagePolicy").put("approvalFromUnits",1_000_001) },
            { it.getJSONObject("policy").getJSONObject("damagePolicy").put("photoMaxBytes",96_001) },
            { it.getJSONObject("policy").getJSONObject("damagePolicy").put("photoRequiredReasons",org.json.JSONArray().put("unknown")) },
            { it.getJSONArray("damageRecords").getJSONObject(0).put("status","lost") }
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
