package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.storage.CallSheetProduct
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SuggestedOrderTest {
    private val text = javaClass.classLoader!!.getResourceAsStream("for-outlet.json")!!
        .bufferedReader().use { it.readText() }
    private val outlet = JSONObject(text).getJSONObject("outlet").getString("outletId")
    private val day = "2026-09-29"
    private fun id(code: String) = JSONObject(text).getJSONArray("lines").let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.first { it.getString("code") == code }.getString("productId")
    }
    private val order get() = SuggestedOrderCodec.decode(text, outlet, day)
    private fun product(id: String, code: String) = CallSheetProduct(id, code, "Name $code", "CS", null, null)
    // P1/P2/P5 on the sheet, P3 (no history) too, plus one product the engine says nothing about; P4 is off-sheet.
    private val sheet get() = CallSheet(outlet, 1, CallSheetHeader("Store", null, null, null, null, null, null, null, null, null),
        listOf(product(id("P1"), "P1"), product(id("P2"), "P2"), product(id("P5"), "P5"), product(id("P3"), "P3"),
            product("other", "X")))
    private val blank get() = sheet.lines.map { CallSheetDraftLine(it.productId) }

    private fun mutate(block: (JSONObject) -> Unit) = JSONObject(text).also(block).toString()

    @Test fun decodesTheEngineResponseForTheRequestedStoreAndDay() {
        val o = order
        assertEquals(8, o.coverDays); assertEquals(7, o.nextVisitDays); assertEquals(1, o.leadTimeDays)
        assertTrue(o.leadTimeProvisional)
        assertEquals(listOf("P1", "P2", "P4", "P5", "P3"), o.lines.map { it.code })
        val p1 = o.lines.first()
        assertEquals("suggest", p1.status); assertEquals(8, p1.wholeQuantity); assertTrue(p1.canUse)
        assertEquals("Suggest 8 CS", p1.reasons.last())
        assertThrows(SuggestedOrderWireFailure::class.java) { SuggestedOrderCodec.decode(text, "other-outlet", day) }
        assertThrows(SuggestedOrderWireFailure::class.java) { SuggestedOrderCodec.decode(text, outlet, "2026-09-30") }
        assertThrows(SuggestedOrderWireFailure::class.java) { SuggestedOrderCodec.decode("{}", outlet, day) }
        assertThrows(SuggestedOrderWireFailure::class.java) { SuggestedOrderCodec.decode("not json", outlet, day) }
    }

    @Test fun boundsAndUnknownValuesNeverBecomeActions() {
        val tooMany = mutate { o ->
            val line = o.getJSONArray("lines").getJSONObject(0)
            o.put("lines", JSONArray().apply { repeat(201) { put(line) } })
        }
        assertThrows(SuggestedOrderWireFailure::class.java) { SuggestedOrderCodec.decode(tooMany, outlet, day) }
        val odd = mutate { o ->
            val lines = o.getJSONArray("lines")
            lines.getJSONObject(0).put("status", "future_status").put("extra", 1)
            lines.getJSONObject(1).put("suggestedQuantity", 2.5)
                .put("reasons", JSONArray().apply { repeat(12) { put("r".repeat(400)) } })
            lines.getJSONObject(2).put("productId", JSONObject.NULL)
            o.put("newTopLevel", true)
        }
        val o = SuggestedOrderCodec.decode(odd, outlet, day)
        assertEquals("future_status", o.lines[0].status); assertFalse(o.lines[0].canUse)
        assertEquals("No suggestion", SuggestedOrderRules.statusText(o.lines[0]))
        assertFalse(o.lines[1].canUse); assertNull(o.lines[1].wholeQuantity)
        assertEquals(10, o.lines[1].reasons.size); assertEquals(300, o.lines[1].reasons[0].length)
        assertNull(o.lines[2].productId)
        // An unsafe line is never typed into Order.
        assertEquals(blank, SuggestedOrderRules.use(o, blank, id("P1")))
        assertEquals(blank, SuggestedOrderRules.use(o, blank, id("P2")))
    }

    @Test fun useOverwritesOnlyThatProductsOrder() {
        val typed = blank.map { if (it.productId == id("P1")) it.copy(order = "3", take = "2") else it }
        val used = SuggestedOrderRules.use(order, typed, id("P1"))
        assertEquals(CallSheetDraftLine(id("P1"), order = "8", take = "2"), used.first { it.productId == id("P1") })
        assertEquals(typed.filter { it.productId != id("P1") }, used.filter { it.productId != id("P1") })
        // Enough stock / no history / unknown products offer nothing to use.
        for (p in listOf(id("P5"), id("P3"), "other")) assertEquals(typed, SuggestedOrderRules.use(order, typed, p))
    }

    @Test fun useAllFillsOnlyEmptyOrderFieldsOfSuggestedSheetProducts() {
        val typed = blank.map { if (it.productId == id("P2")) it.copy(order = "1") else it }
        val filled = SuggestedOrderRules.useAll(order, sheet, typed)
        assertEquals(listOf("8", "1", "", "", ""), filled.map { it.order })
        assertTrue(filled.all { d -> d.values().drop(1).all { it.isEmpty() } })
        assertTrue(SuggestedOrderRules.hasApplicable(order, sheet))
        // Another store's suggestions never touch this sheet.
        assertEquals(typed, SuggestedOrderRules.useAll(order, sheet.copy(outletId = "x"), typed))
        assertFalse(SuggestedOrderRules.hasApplicable(order, sheet.copy(outletId = "x")))
    }

    @Test fun acceptedSuggestionsBuildTheSamePayloadAsTypedNumbers() {
        val accepted = CallSheetPayload.activity(sheet, SuggestedOrderRules.useAll(order, sheet, blank))
        val typed = CallSheetPayload.activity(sheet, blank.map {
            when (it.productId) { id("P1") -> it.copy(order = "8"); id("P2") -> it.copy(order = "4"); else -> it }
        })
        assertEquals(typed.toString(), accepted.toString())
        assertEquals(setOf("kind", "lines"), accepted.keys().asSequence().toSet())
    }

    @Test fun offSheetSuggestionsAndWording() {
        assertEquals(listOf("P4"), SuggestedOrderRules.notOnSheet(order, sheet).map { it.code })
        val byCode = order.lines.associateBy { it.code }
        assertEquals("Suggested: 8 CS", SuggestedOrderRules.statusText(byCode.getValue("P1")))
        assertEquals("Enough stock — no order suggested", SuggestedOrderRules.statusText(byCode.getValue("P5")))
        assertEquals("No purchases in 12 weeks — no suggestion", SuggestedOrderRules.statusText(byCode.getValue("P3")))
        assertEquals("Not available to sell",
            SuggestedOrderRules.statusText(byCode.getValue("P1").copy(status = "unavailable")))
        assertEquals("3 product(s) suggested · covers 8 days (7 to next visit + 1 lead time)\nLead time is provisional.",
            SuggestedOrderRules.summary(order))
        assertEquals(JSONObject().put("outletId", outlet).put("asOfDate", day).toString(),
            SuggestedOrderCodec.args(outlet, day).toString())
    }

    private class Cache : SuggestedOrderCache {
        val rows = mutableMapOf<String, Pair<String, Long>>()
        override fun read(key: String) = rows[key]
        override fun write(key: String, json: String, savedAt: Long) { rows[key] = json to savedAt }
    }

    @Test fun repositorySavesLiveAnswersAndOnlyFallsBackWhenOffline() {
        val cache = Cache()
        val savedAt = java.time.Instant.parse("2026-09-29T01:05:00Z").toEpochMilli() // 9:05 AM Manila
        assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, savedAt) { text }.order)
        assertEquals(setOf("$day|$outlet"), cache.rows.keys)
        val offline = SuggestedOrderRepository.load(outlet, day, cache, savedAt + 1) {
            throw AuthFailure(AuthFailure.Kind.OFFLINE)
        }
        assertNotNull(offline.order)
        assertEquals("Offline — showing suggestions loaded at 9:05 AM", offline.message)
        // Refused, signed out or unreadable: never show saved suggestions.
        val refused = SuggestedOrderRepository.load(outlet, day, cache, 1) { throw ConvexFunctionError(null) }
        assertNull(refused.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, refused.message)
        val expired = SuggestedOrderRepository.load(outlet, day, cache, 1) {
            throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        }
        assertNull(expired.order); assertEquals(SuggestedOrderRepository.SIGN_IN, expired.message)
        val bad = SuggestedOrderRepository.load(outlet, day, cache, 1) { "{}" }
        assertNull(bad.order); assertEquals(SuggestedOrderRepository.UNREADABLE, bad.message)
        // Another store or day has nothing saved.
        val other = SuggestedOrderRepository.load("other", day, cache, 1) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        assertNull(other.order); assertEquals(SuggestedOrderRepository.CONNECTION, other.message)
    }
}
