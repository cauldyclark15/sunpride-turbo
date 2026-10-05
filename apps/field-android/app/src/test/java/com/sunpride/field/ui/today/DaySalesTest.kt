package com.sunpride.field.ui.today

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.ProductiveCall
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class DaySalesTest {
    private val day = "2026-10-05"
    private fun report(date: String = day, daily: Any? = 2_500_000, today: Any = 1_000_050, pct: Any? = 40,
        rule: String? = ProductiveCall.TRUCK_SELLER) = JSONObject()
        .put("serviceDate", date)
        .put("targets", JSONObject().put("daily", daily ?: JSONObject.NULL).put("monthly", 65_000_000))
        .put("totals", JSONObject().put("todaySales", today).put("todayPct", pct ?: JSONObject.NULL)
            .put("mtdSales", 12_345_600))
        .put("calls", JSONObject().apply { rule?.let { put("productiveCallRule", it) } }).toString()

    private class Cache : DaySalesCache {
        val rows = mutableMapOf<String, Pair<String, Long>>()
        override fun read(key: String) = rows[key]
        override fun write(key: String, json: String, savedAt: Long) { rows[key] = json to savedAt }
    }

    @Test fun decodesCentavosAndTheGovernedRule() {
        val s = DaySalesCodec.decode(report())
        assertEquals(DaySales(day, 2_500_000, 1_000_050, 40, 65_000_000, 12_345_600, ProductiveCall.TRUCK_SELLER), s)
        assertEquals("₱25,000.00", DaySalesText.target(s))
        assertEquals("₱10,000.50 · 40%", DaySalesText.sold(s))
        assertEquals("₱123,456.00 of ₱650,000.00", DaySalesText.month(s))
        val bare = DaySalesCodec.decode(report(daily = null, pct = null, rule = null))
        assertEquals("No target set", DaySalesText.target(bare)); assertNull(bare.productiveCallRule)
        assertNull(DaySalesCodec.decode(report(rule = "made_up")).productiveCallRule)
    }

    @Test fun rejectsMalformedAmounts() {
        assertThrows(DaySalesWireFailure::class.java) { DaySalesCodec.decode(report(today = 1.5)) }
        assertThrows(DaySalesWireFailure::class.java) { DaySalesCodec.decode(report(today = -1)) }
        assertThrows(DaySalesWireFailure::class.java) { DaySalesCodec.decode("{}") }
    }

    @Test fun liveIsSavedAndOfflineShowsTheSavedCopy() {
        val cache = Cache()
        val live = DaySalesRepository.load(day, cache, 100L) { report() }
        assertEquals(1_000_050L, live.sales?.todaySales); assertNull(live.savedAt)
        val offline = DaySalesRepository.load(day, cache, 200L) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        assertEquals(1_000_050L, offline.sales?.todaySales); assertEquals(100L, offline.savedAt)
        assertEquals(100L, DaySalesRepository.load(day, cache, 300L, null).savedAt)
    }

    @Test fun refusalWrongDayAndNoCopyNeverShowFigures() {
        val cache = Cache().apply { write(day, report(), 1L) }
        val refused = DaySalesRepository.load(day, cache, 2L) { throw ConvexFunctionError("Forbidden") }
        assertNull(refused.sales); assertEquals("Not available for your account", refused.message)
        val wrongDay = DaySalesRepository.load(day, Cache(), 2L) { report(date = "2026-10-04") }
        assertNull(wrongDay.sales)
        assertEquals("Sync to see sales", DaySalesRepository.load(day, Cache(), 2L, null).message)
        assertNull(DaySalesRepository.load("2026-10-06", cache, 2L, null).sales)
    }
}
