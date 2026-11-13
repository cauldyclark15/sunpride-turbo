package com.sunpride.van.pos

import com.sunpride.van.data.PaymentKind
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** NF-5 (VAN-075): a seller who signs in on another phone mid-trip expects the same cash as the office. */
class ServerTripCashTest {
    private fun row(sale: String, kind: String, minor: Long) = JSONObject().put("saleId", sale).put("kind", kind).put("amountMinor", minor.toString())
    private val trip = JSONObject().put("tripId", "t").put("openingFloatCentavos", 100000)
        .put(ServerTripCash.FIELD, JSONArray().put(row("a", "sale", 50000)).put(row("b", "sale", 20000))
            .put(row("b", "void_refund", 20000)).put(row("mine", "sale", 7000)).put(row("c", "refund", 0)))
    private fun local(id: String, minor: Long) = TripPayment(id, "R-$id", "cash", "Cash", PaymentKind.CASH, minor, "PHP", false)

    @Test fun addsTheOfficesCashForSalesThisPhoneDoesNotHold() {
        val other = ServerTripCash.otherPhones(ServerTripCash.decode(trip), setOf("mine"))
        assertEquals(ServerTripCash.OtherPhones(1, 50000), other)
        val e = CashReconciliationRules.expectation(listOf(local("mine", 7000)), 100000, 0, other)
        // Office: float 1,000 + 500 + 200 - 200 (void) + 70 (this phone's sale) = 1,570.00
        assertEquals(157000, e.expectedMinor)
        assertEquals(1, e.otherPhoneSales); assertEquals(50000, e.otherPhoneMinor); assertEquals(1, e.cashSales)
    }

    @Test fun theVanSeventyFiveCaseNoLocalSales() {
        // r3: 7 seeded sales on the server, a freshly signed-in phone with none. Before the fix it expected the float only.
        val seven = JSONObject().put(ServerTripCash.FIELD, JSONArray().apply { (1..7).forEach { put(row("s$it", "sale", 10000)) } })
        val e = CashReconciliationRules.expectation(emptyList(), 0, 0, ServerTripCash.otherPhones(ServerTripCash.decode(seven), emptySet()))
        assertEquals(70000, e.expectedMinor)
        assertEquals(7, e.otherPhoneSales)
    }

    @Test fun anOlderServerWithoutTheListKeepsTheOldRule() {
        assertNull(ServerTripCash.decode(JSONObject().put("tripId", "t")))
        val e = CashReconciliationRules.expectation(listOf(local("mine", 7000)), 0, 0, ServerTripCash.otherPhones(null, setOf("mine")))
        assertEquals(7000, e.expectedMinor); assertEquals(0, e.otherPhoneSales)
    }

    @Test fun refusesAMalformedRow() {
        val bad = JSONObject().put(ServerTripCash.FIELD, JSONArray().put(row("a", "gift", 1)))
        assertThrows(IllegalArgumentException::class.java) { ServerTripCash.decode(bad) }
    }
}
