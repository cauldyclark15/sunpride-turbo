package com.sunpride.van.sync

import com.sunpride.van.data.*
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class VanBootstrapCodecTest {
    private fun fixture(name: String = "bootstrap-response.json") = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
    private fun jsonValue(value: Any): Any = when (value) {
        is JSONObject -> value.keys().asSequence().associateWith { jsonValue(value.get(it)) }
        is JSONArray -> (0 until value.length()).map { jsonValue(value.get(it)) }
        else -> value
    }
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
    @Test fun policyAndCustomersWithoutPaymentFieldsAllowCashOnly() {
        val o = JSONObject(fixture()); o.getJSONObject("policy").remove("paymentMethods"); o.getJSONArray("customers").getJSONObject(0).remove("credit")
        val b = VanBootstrapCodec.decode(o.toString())
        assertEquals(PaymentMethod.CASH_ONLY,b.policy.paymentMethods); assertNull(b.customers[0].credit)
        assertEquals(PaymentMethod.CASH_ONLY,VanBootstrapCodec.decode(fixture("bootstrap-no-trip-response.json")).policy.paymentMethods)
    }
    @Test fun voidPolicyDecodesAndOldCachedPolicyStillWorks() {
        val b = VanBootstrapCodec.decode(fixture())
        assertEquals(com.sunpride.van.pos.VoidReasons.ALL.map { it.code },b.policy.voidReasons)
        assertEquals(VoidApproval(true,0,"6Heg4RirM2SuTt_Pjg5QZwyqg_P-Szkdlxli4UBfz1Y"),b.policy.voidApproval)
        val o = JSONObject(fixture()).getJSONObject("policy")
        o.remove("voidReasons"); o.remove("voidApproval")
        val cached = VanBootstrapCodec.policy(o)
        assertTrue(cached.voidReasons.isEmpty()); assertNull(cached.voidApproval)
        val old = VanBootstrapCodec.decode(fixture("bootstrap-no-trip-response.json")).policy
        assertTrue(old.voidReasons.isEmpty()); assertNull(old.voidApproval)
        o.put("voidApproval",JSONObject().put("required",true).put("thresholdMinor","9007199254740993").put("key",JSONObject.NULL))
        assertEquals(VoidApproval(true,9007199254740993L,null),VanBootstrapCodec.policy(o).voidApproval)
    }
    @Test fun invalidVoidPolicyIsRejectedByTheMirroredSchema() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("voidReasons",org.json.JSONArray()) },
            { it.put("voidReasons",org.json.JSONArray().put("delete")) },
            { it.getJSONObject("voidApproval").put("thresholdMinor",0) },
            { it.getJSONObject("voidApproval").put("key","not-a-key") },
            { it.getJSONObject("voidApproval").remove("required") })
        mutations.forEach { mutate -> val o = JSONObject(fixture()); mutate(o.getJSONObject("policy"))
            assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) } }
    }
    @Test fun frozenBootstrapIncludesGovernedPricesAndToleratesAllPromotionRules() {
        val o = JSONObject(fixture())
        assertEquals(listOf("buy_x_get_y","percent_off","bundle"),
            VanBootstrapCodec.objects(o.getJSONArray("promotions")).map { it.getJSONObject("rule").getString("kind") })
        val b = VanBootstrapCodec.decode(o.toString())
        assertEquals(listOf(
            PriceLine("k57plst000000000000000000000002","k57prod0000000000000000000000001","PC",6850,"PHP",1790812800000L,null),
            PriceLine("k57plst000000000000000000000002","k57prod0000000000000000000000002","PC",4275,"PHP",1790812800000L,null)
        ),b.priceLines)
    }
    @Test fun debugFixtureMatchesFrozenFixtureWithAlwaysEffectivePricesAndNoPromotions() {
        val expected = JSONObject(fixture()).apply { remove("promotions") }
        VanBootstrapCodec.objects(expected.getJSONArray("priceLines")).forEach { it.put("effectiveFrom",0) }
        assertEquals(jsonValue(expected),jsonValue(JSONObject(FakeVanBackend.FIXTURE)))
        val b = VanBootstrapCodec.decode(FakeVanBackend.FIXTURE)
        assertEquals(listOf(6850L,4275L),b.priceLines.map { it.unitPriceMinor })
        assertTrue(b.priceLines.all { it.currency == "PHP" && it.effectiveFrom == 0L && it.effectiveTo == null })
    }
    @Test fun missingOrEmptyPriceLinesDecodeToEmptyList() {
        val o = JSONObject(fixture()).apply { remove("priceLines") }
        assertTrue(VanBootstrapCodec.decode(o.toString()).priceLines.isEmpty())
        o.put("priceLines",JSONArray())
        assertTrue(VanBootstrapCodec.decode(o.toString()).priceLines.isEmpty())
    }
    @Test fun unknownPriceProductIsRejected() {
        val o = JSONObject(fixture())
        o.getJSONArray("priceLines").getJSONObject(0).put("productId","unknown-product")
        assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) }
    }
    @Test fun duplicatePriceListProductIsRejectedEvenForDifferentUnits() {
        listOf("PC","CS").forEach { uom ->
            val o = JSONObject(fixture()); val prices = o.getJSONArray("priceLines")
            prices.put(JSONObject(prices.getJSONObject(0).toString()).put("uomCode",uom))
            assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) }
        }
    }
    @Test fun sameProductOnDifferentPriceListsIsValid() {
        val o = JSONObject(fixture()); val prices = o.getJSONArray("priceLines")
        prices.put(JSONObject(prices.getJSONObject(0).toString()).put("priceListId","another-list"))
        assertEquals(3,VanBootstrapCodec.decode(o.toString()).priceLines.size)
    }
    @Test fun invalidMinorPricesAreRejected() {
        listOf("-1","not-a-number","1.5","9223372036854775808","",6850,JSONObject.NULL).forEach { minor ->
            val o = JSONObject(fixture())
            o.getJSONArray("priceLines").getJSONObject(0).put("unitPriceMinor",minor)
            assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) }
        }
        val o = JSONObject(fixture())
        o.getJSONArray("priceLines").getJSONObject(0).put("unitPriceMinor","0")
        assertEquals(0L,VanBootstrapCodec.decode(o.toString()).priceLines.first().unitPriceMinor)
    }
    @Test fun priceEndMustBeNullOrStrictlyAfterStart() {
        val o = JSONObject(fixture()); val line = o.getJSONArray("priceLines").getJSONObject(0)
        val from = line.getLong("effectiveFrom")
        listOf(from,from-1).forEach { to ->
            line.put("effectiveTo",to)
            assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) }
        }
        line.put("effectiveTo",from+1)
        assertEquals(from+1,VanBootstrapCodec.decode(o.toString()).priceLines.first().effectiveTo)
        line.put("effectiveTo",JSONObject.NULL)
        assertNull(VanBootstrapCodec.decode(o.toString()).priceLines.first().effectiveTo)
    }
    @Test fun malformedPricesAndPromotionsStillFailSchemaValidation() {
        val mutations: List<(JSONObject)->Unit> = listOf(
            { it.put("priceLines",JSONObject.NULL) },
            { it.getJSONArray("priceLines").getJSONObject(0).remove("priceListCode") },
            { it.getJSONArray("priceLines").getJSONObject(0).put("effectiveFrom",-1) },
            { it.getJSONArray("priceLines").getJSONObject(0).put("extra",true) },
            { it.put("promotions",JSONObject.NULL) },
            { it.getJSONArray("promotions").getJSONObject(0).getJSONObject("rule").put("kind","unsupported") },
            { it.getJSONArray("promotions").getJSONObject(0).getJSONObject("rule").remove("free") },
            { it.getJSONArray("promotions").getJSONObject(1).getJSONObject("rule").put("percentOffBasisPoints",10001) },
            { it.getJSONArray("promotions").getJSONObject(1).getJSONObject("rule").put("percentOffBasisPoints",0) },
            { it.getJSONArray("promotions").getJSONObject(2).getJSONObject("rule").getJSONArray("components").remove(1) }
        )
        mutations.forEach { change -> val o = JSONObject(fixture()); change(o); assertThrows(VanWireFailure::class.java) { VanBootstrapCodec.decode(o.toString()) } }
    }
    @Test fun frozenNoTripIsValidEmptyState() {
        val b = VanBootstrapCodec.decode(fixture("bootstrap-no-trip-response.json")); assertNull(b.trip); assertNull(b.load); assertTrue(b.truckStock.isEmpty()); assertTrue(b.priceLines.isEmpty())
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
            { it.getJSONArray("customers").getJSONObject(0).getJSONObject("credit").put("availableMinor","10.5") }
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
