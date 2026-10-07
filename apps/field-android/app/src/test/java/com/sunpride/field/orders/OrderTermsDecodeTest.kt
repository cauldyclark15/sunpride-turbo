package com.sunpride.field.orders

import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.sync.WireFailure
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class OrderTermsDecodeTest {
    private fun fixture(name: String = "bootstrap-order-terms-response.json") = JSONObject(javaClass.classLoader!!
        .getResourceAsStream(name)!!.bufferedReader().use { it.readText() })
    private fun page(o: JSONObject) = BootstrapCodec.page(o.toString())
    private fun malformed(key: String, change: (JSONObject) -> Unit) {
        val o = fixture()
        change(o.getJSONArray(key).getJSONObject(0))
        assertThrows(WireFailure::class.java) { page(o) }
    }
    @Test fun validAndOmittedFieldsRoundTripAndStayWithTheSnapshot() = runBlocking {
        val o = fixture()
        val p = page(o)
        assertEquals(listOf("PC", "CS", "PC"), p.orderTerms.single().lines.map { it.uom })
        assertEquals(4525L, p.orderTerms.single().lines.first().unitPriceMinor)
        assertNull(p.orderTerms.single().lines.last().unitPriceMinor)
        assertEquals("PHP", p.orderTerms.single().priceList!!.currency)
        assertTrue(p.orderTerms.single().priceList!!.sample)
        assertEquals(p.orderTerms, page(JSONObject(String(BootstrapCodec.encode(p)))).orderTerms)
        val store = FakeFieldStore(StoreScope("test", "device", "scope"))
        store.swap(store.stage(BootstrapCodec.snapshot(listOf(p))), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        assertEquals(p.orderTerms.single(), store.orderTerms("outlet-1"))
        assertEquals(p.accountSummaries.single(), store.accountSummary("outlet-1"))
        o.remove("orderTerms"); o.remove("accountSummaries")
        assertTrue(page(o).orderTerms.isEmpty()); assertTrue(page(o).accountSummaries.isEmpty())
        store.swap(store.stage(BootstrapCodec.snapshot(listOf(page(o)))), "next", Long.MAX_VALUE, Long.MAX_VALUE)
        assertNull(store.orderTerms("outlet-1")); assertNull(store.accountSummary("outlet-1"))
    }
    @Test fun summaryOnlyFixtureIsAcceptedAndRoundTrips() {
        val p = page(fixture("bootstrap-account-summary-response.json"))
        assertEquals(5000000L, p.accountSummaries.single().creditLimitMinor)
        assertEquals(9L, p.accountSummaries.single().sales!!.orders)
        assertEquals(410000L, p.accountSummaries.single().openOrders!!.amountMinor)
        assertEquals(p.accountSummaries.single(), AccountSummaryCodec.decode(AccountSummaryCodec.encode(p.accountSummaries.single())))
    }
    @Test fun nullOrNonArrayOptionalFieldsAndConfigChangeAreRefused() {
        for (key in listOf("orderTerms", "accountSummaries")) for (v in listOf(JSONObject.NULL, true, "[]", JSONObject()))
            assertThrows(WireFailure::class.java) { page(fixture().put(key, v)) }
        // A different price mode is not a malformed page: it is an unsupported snapshot (never used).
        val o = fixture(); o.getJSONObject("appConfig").put("priceAvailability", "available")
        assertEquals(false, page(o).supported)
    }
    @Test fun malformedTermsAndUnitsFailClosed() {
        for (change in listOf<(JSONObject) -> Unit>(
            { it.put("outletId", "foreign") }, { it.remove("priceList") }, { it.put("unexpected", true) },
            { it.put("lines", JSONObject.NULL) },
            { it.getJSONObject("priceList").put("currency", "php") },
            { it.getJSONObject("priceList").put("sample", "true") },
            { it.getJSONObject("priceList").put("id", "") },
            { it.getJSONArray("lines").put(it.getJSONArray("lines").getJSONObject(0)) },
            { it.getJSONArray("lines").getJSONObject(0).remove("unitPriceMinor") },
            { it.getJSONArray("lines").getJSONObject(0).put("extra", 1) },
            { it.getJSONArray("lines").getJSONObject(0).put("productId", "") },
            { it.put("priceList", JSONObject.NULL) }
        )) malformed("orderTerms", change)
        for (value in listOf(-1, 1.5, true, "4525", java.math.BigInteger("9223372036854775808")))
            malformed("orderTerms") { it.getJSONArray("lines").getJSONObject(0).put("unitPriceMinor", value) }
        for (unit in listOf("", "X".repeat(21)))
            malformed("orderTerms") { it.getJSONArray("lines").getJSONObject(0).put("uom", unit) }
    }
    @Test fun nullListAndNullOrZeroPricesAreAccepted() {
        val o = fixture()
        val term = o.getJSONArray("orderTerms").getJSONObject(0)
        term.put("priceList", JSONObject.NULL).put("lines", JSONArray().put(JSONObject()
            .put("productId", "p").put("uom", "PC").put("unitPriceMinor", JSONObject.NULL)))
        assertNull(page(o).orderTerms.single().priceList)
        val priced = fixture(); priced.getJSONArray("orderTerms").getJSONObject(0).getJSONArray("lines")
            .getJSONObject(0).put("unitPriceMinor", 0)
        assertEquals(0L, page(priced).orderTerms.single().lines.first().unitPriceMinor)
    }
    @Test fun malformedSummaryFiguresAndDatesFailClosed() {
        for (change in listOf<(JSONObject) -> Unit>(
            { it.put("outletId", "foreign") }, { it.put("availability", "unknown") }, { it.put("asOfDate", "2026-02-30") },
            { it.remove("creditLimitMinor") }, { it.remove("sales") }, { it.remove("openOrders") }, { it.put("extra", 1) },
            { it.put("creditLimitMinor", -1) }, { it.put("creditLimitMinor", "1") }, { it.put("creditLimitMinor", 1.5) },
            { it.put("availability", "withheld") }, { it.getJSONObject("openOrders").put("count", -1) },
            { it.getJSONObject("openOrders").put("amountMinor", true) },
            { it.getJSONObject("sales").put("complete", "true") }, { it.getJSONObject("sales").put("orders", -1) },
            { it.getJSONObject("sales").put("recentOrders", 10) }, { it.getJSONObject("sales").put("from", "2026-09-27") },
            { it.getJSONObject("sales").put("to", "2026-09-25") },
            { it.getJSONObject("sales").put("lastOrderDate", "2026-01-01") },
            { it.getJSONObject("sales").put("lastOrderAmountMinor", JSONObject.NULL) },
            { it.getJSONObject("sales").remove("lastOrderAmountMinor") }
        )) malformed("accountSummaries", change)
    }
    @Test fun withheldAndSignedAmountsAreAccepted() {
        val o = fixture(); val s = o.getJSONArray("accountSummaries").getJSONObject(0)
        s.put("availability", "withheld").put("creditLimitMinor", JSONObject.NULL)
            .put("sales", JSONObject.NULL).put("openOrders", JSONObject.NULL)
        assertEquals("withheld", page(o).accountSummaries.single().availability)
        val signed = fixture(); val summary = signed.getJSONArray("accountSummaries").getJSONObject(0)
        summary.getJSONObject("sales").put("amountMinor", -5)
        summary.getJSONObject("openOrders").put("amountMinor", -2)
        assertEquals(-5L, page(signed).accountSummaries.single().sales!!.amountMinor)
    }
    @Test fun pageDuplicatesBoundsAndCrossPageDriftAreRefusedButIdenticalRepeatsMerge() {
        for (key in listOf("orderTerms", "accountSummaries")) {
            val o = fixture(); val row = o.getJSONArray(key).getJSONObject(0)
            o.getJSONArray(key).put(row)
            assertThrows(WireFailure::class.java) { page(o) }
            val tooMany = fixture().put(key, JSONArray().apply { repeat(201) { put(row) } })
            assertThrows(WireFailure::class.java) { page(tooMany) }
        }
        val o = fixture()
        val first = page(JSONObject(o.toString()).put("syncCursor", JSONObject.NULL).put("nextPageCursor", "next"))
        val last = page(o)
        val merged = BootstrapCodec.snapshot(listOf(first, last))
        assertEquals(1, merged.outlets.size)
        assertTrue(JSONObject(merged.outlets.single().json).has("orderTerms"))
        val changedTerms = JSONObject(o.toString()); changedTerms.getJSONArray("orderTerms").getJSONObject(0)
            .getJSONArray("lines").getJSONObject(0).put("unitPriceMinor", 4600)
        assertThrows(IllegalArgumentException::class.java) { BootstrapCodec.snapshot(listOf(first, page(changedTerms))) }
        val changedSummary = JSONObject(o.toString()); changedSummary.getJSONArray("accountSummaries").getJSONObject(0)
            .put("creditLimitMinor", 1)
        assertThrows(IllegalArgumentException::class.java) { BootstrapCodec.snapshot(listOf(first, page(changedSummary))) }
        val once = JSONObject(o.toString()); once.remove("orderTerms"); once.remove("accountSummaries")
        assertEquals(merged, BootstrapCodec.snapshot(listOf(first, page(once))))
        val oversized = fixture(); oversized.getJSONArray("orderTerms").getJSONObject(0).put("lines",
            JSONArray().apply { repeat(1801) { put(JSONObject().put("productId", "p$it").put("uom", "PC").put("unitPriceMinor", 0)) } })
        assertThrows(WireFailure::class.java) { page(oversized) }
    }
}
