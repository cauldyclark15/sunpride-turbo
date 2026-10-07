package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.storage.CallSheetProduct
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
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

    /** Each test starts as a fresh app process: no refusal latched in memory. */
    @Before fun freshProcess() = SuggestedOrderRepository.forgetSessionDenials()

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
        assertEquals("complete", order.historyStatus)
        // ANA-009 scoped history: say why less history was used; unknown statuses add nothing.
        assertEquals("3 product(s) suggested · covers 8 days (7 to next visit + 1 lead time)\nLead time is provisional." +
            "\nThis account is shared with another store, so its order history is not used.",
            SuggestedOrderRules.summary(order.copy(historyStatus = "shared_account")))
        assertEquals("Some of this account's orders are outside your area and were not counted.",
            SuggestedOrderRules.historyNote("partial_scope"))
        assertEquals(null, SuggestedOrderRules.historyNote("something_new"))
        assertEquals(null, SuggestedOrderCodec.decode(JSONObject(text).apply { remove("historyStatus") }.toString(),
            outlet, day).historyStatus)
        assertEquals(JSONObject().put("outletId", outlet).put("asOfDate", day).toString(),
            SuggestedOrderCodec.args(outlet, day).toString())
    }

    private class Cache : SuggestedOrderCache {
        val rows = mutableMapOf<String, SuggestedOrderCacheRow>()
        override fun read(key: String) = rows[key]
        override fun write(key: String, json: String, savedAt: Long) { rows[key] = SuggestedOrderCacheRow(json, savedAt) }
        override fun block(key: String, reason: String, at: Long) { rows[key] = SuggestedOrderCacheRow(null, at, reason) }
    }

    private val offline: () -> String = { throw AuthFailure(AuthFailure.Kind.OFFLINE) }

    @Test fun aRefusalDurablyReplacesSavedSuggestionsUntilALiveAnswer() {
        for ((refusal, message) in listOf<Pair<() -> String, String>>(
            { throw ConvexFunctionError("Forbidden") } to SuggestedOrderRepository.NOT_ALLOWED,
            { throw AuthFailure(AuthFailure.Kind.REFUSED) } to SuggestedOrderRepository.NOT_ALLOWED,
            { throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED) } to SuggestedOrderRepository.SIGN_IN,
            { "{}" } to SuggestedOrderRepository.UNREADABLE)) {
            val cache = Cache()
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 10) { text }.order)
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 11, offline).order)
            val refused = SuggestedOrderRepository.load(outlet, day, cache, 12, refusal)
            assertNull(refused.order); assertEquals(message, refused.message)
            // Success -> refusal -> offline (reopen or relaunch): the saved answer is gone and stays refused.
            assertNull(cache.rows.getValue("$day|$outlet").json)
            repeat(2) {
                val reopened = SuggestedOrderRepository.load(outlet, day, cache, 13, offline)
                assertNull(reopened.order); assertEquals(message, reopened.message)
            }
            // Only a fresh live answer brings suggestions back.
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 14) { text }.order)
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 15, offline).order)
        }
    }

    @Test fun aRefusalThatCannotBeSavedStillNeverShowsData() {
        val cache = object : SuggestedOrderCache {
            override fun read(key: String) = throw IllegalStateException("db")
            override fun write(key: String, json: String, savedAt: Long) = throw IllegalStateException("db")
            override fun block(key: String, reason: String, at: Long) = throw IllegalStateException("db")
        }
        val refused = SuggestedOrderRepository.load(outlet, day, cache, 1) { throw ConvexFunctionError(null) }
        assertNull(refused.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, refused.message)
        val reopened = SuggestedOrderRepository.load(outlet, day, cache, 2, offline)
        assertNull(reopened.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, reopened.message)
    }

    /** Release counterexample: reads keep working while the refusal-marker write fails. */
    @Test fun readableCacheMustNotReturnAfterFailedDenialWrite() {
        for ((refusal, message) in listOf<Pair<() -> String, String>>(
            { throw ConvexFunctionError("Forbidden") } to SuggestedOrderRepository.NOT_ALLOWED,
            { throw AuthFailure(AuthFailure.Kind.REFUSED) } to SuggestedOrderRepository.NOT_ALLOWED,
            { throw AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS) } to SuggestedOrderRepository.SIGN_IN,
            { "{}" } to SuggestedOrderRepository.UNREADABLE)) {
            SuggestedOrderRepository.forgetSessionDenials()
            var blockFailures = Int.MAX_VALUE
            var blockAttempts = 0
            val cache = object : SuggestedOrderCache {
                val inner = Cache()
                override fun read(key: String) = inner.read(key)
                override fun write(key: String, json: String, savedAt: Long) = inner.write(key, json, savedAt)
                override fun block(key: String, reason: String, at: Long) {
                    blockAttempts++
                    if (blockFailures-- > 0) throw IllegalStateException("disk full")
                    inner.block(key, reason, at)
                }
            }
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 10) { text }.order)
            val refused = SuggestedOrderRepository.load(outlet, day, cache, 11, refusal)
            assertNull(refused.order); assertEquals(message, refused.message)
            // The old answer is still readable on the phone, but this session never shows it again.
            assertNotNull(cache.inner.rows.getValue("$day|$outlet").json)
            repeat(3) {
                val reopened = SuggestedOrderRepository.load(outlet, day, cache, 12L + it, offline)
                assertNull(reopened.order); assertEquals(message, reopened.message)
            }
            // Each blocked offline open retries the durable marker; once storage recovers it sticks across relaunch.
            val before = blockAttempts
            blockFailures = 0
            assertNull(SuggestedOrderRepository.load(outlet, day, cache, 20, offline).order)
            assertEquals(before + 1, blockAttempts)
            assertNull(cache.inner.rows.getValue("$day|$outlet").json)
            SuggestedOrderRepository.forgetSessionDenials() // app relaunch
            val relaunched = SuggestedOrderRepository.load(outlet, day, cache, 21, offline)
            assertNull(relaunched.order); assertEquals(message, relaunched.message)
            // Only a fresh live answer brings suggestions back, in memory and on the phone.
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 22) { text }.order)
            assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 23, offline).order)
        }
    }

    /** Release counterexample: an older in-flight success lands after a newer refusal for the same store/day. */
    @Test fun anOverlappingOlderSuccessNeverUndoesANewerRefusal() {
        val cache = Cache()
        assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 1) { text }.order)
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val older = java.util.concurrent.CompletableFuture.supplyAsync {
            SuggestedOrderRepository.load(outlet, day, cache, 2) {
                entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)); text
            }
        }
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        assertNull(SuggestedOrderRepository.load(outlet, day, cache, 3) { throw ConvexFunctionError("Forbidden") }.order)
        release.countDown()
        val late = older.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertNull(late.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, late.message)
        assertNull(cache.rows.getValue("$day|$outlet").json)
        val reopened = SuggestedOrderRepository.load(outlet, day, cache, 4, offline)
        assertNull(reopened.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, reopened.message)
        SuggestedOrderRepository.forgetSessionDenials() // relaunch: the durable marker still refuses
        assertNull(SuggestedOrderRepository.load(outlet, day, cache, 5, offline).order)
        // A fresh live answer (started after the refusal) still renews.
        assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 6) { text }.order)
    }

    /** Sign-out orphans in-flight requests: a success that lands afterwards is neither saved nor shown. */
    @Test fun signOutOrphansAnInFlightSuccess() {
        val cache = Cache()
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val inFlight = java.util.concurrent.CompletableFuture.supplyAsync {
            SuggestedOrderRepository.load(outlet, day, cache, 1) {
                entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)); text
            }
        }
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        SuggestedOrderRepository.forgetSessionDenials()
        release.countDown()
        assertNull(inFlight.get(5, java.util.concurrent.TimeUnit.SECONDS).order)
        assertTrue(cache.rows.isEmpty())
    }

    /**
     * Release counterexample: the sign-out purge throws while the old saved answers stay readable, then the same
     * account/scope signs back in. The pre-sign-out success must not be saved or shown, and a refusal latched
     * before sign-out must keep hiding the still-readable answer.
     */
    @Test fun signOutRetiresAnInFlightSuccessEvenIfThePurgeFails() {
        val refusedCache = object : SuggestedOrderCache {
            val inner = Cache()
            override fun read(key: String) = inner.read(key)
            override fun write(key: String, json: String, savedAt: Long) = inner.write(key, json, savedAt)
            override fun block(key: String, reason: String, at: Long) = throw IllegalStateException("disk full")
        }
        assertNotNull(SuggestedOrderRepository.load(outlet, day, refusedCache, 1) { text }.order)
        assertNull(SuggestedOrderRepository.load(outlet, day, refusedCache, 2) { throw ConvexFunctionError("Forbidden") }.order)
        val cache = Cache()
        val (inFlight, release) = held(cache, 3)
        var purged = false
        assertThrows(IllegalStateException::class.java) {
            SuggestedOrderRepository.endSession { throw IllegalStateException("purge failed") }
        }
        // Same account/device/scope renewed in this process: nothing else retires the old request.
        release.countDown()
        assertNull(inFlight.get(5, java.util.concurrent.TimeUnit.SECONDS).order)
        assertTrue(cache.rows.isEmpty())
        assertNull(SuggestedOrderRepository.load(outlet, day, cache, 4, offline).order)
        val reopened = SuggestedOrderRepository.load(outlet, day, refusedCache, 5, offline)
        assertNull(reopened.order); assertEquals(SuggestedOrderRepository.NOT_ALLOWED, reopened.message)
        // A successful sign-out purges first, then forgets the session's refusals.
        SuggestedOrderRepository.endSession { purged = true }
        assertTrue(purged)
        assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 6) { text }.order)
    }

    private fun held(cache: SuggestedOrderCache, at: Long): Pair<java.util.concurrent.CompletableFuture<SuggestedOrderView>,
        java.util.concurrent.CountDownLatch> {
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        val future = java.util.concurrent.CompletableFuture.supplyAsync {
            SuggestedOrderRepository.load(outlet, day, cache, at) {
                entered.countDown(); check(release.await(5, java.util.concurrent.TimeUnit.SECONDS)); text
            }
        }
        assertTrue(entered.await(5, java.util.concurrent.TimeUnit.SECONDS))
        return future to release
    }

    /** Scope A → B: an answer asked under A is neither saved nor shown once the lifetime has been retired. */
    @Test fun aScopeChangeRetiresAnInFlightSuccess() {
        val cache = Cache()
        val (inFlight, release) = held(cache, 1)
        SuggestedOrderRepository.retire()
        release.countDown()
        val late = inFlight.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertNull(late.order); assertTrue(cache.rows.isEmpty())
        assertNull(SuggestedOrderRepository.load(outlet, day, cache, 2, offline).order)
    }

    /**
     * Scope A → B → A with the original partition released: equal final scope does not make the old answer
     * current. It must not clear a refusal latched under A, nor replace A's refusal marker.
     */
    @Test fun scopeABackToADoesNotReadmitAnOldAnswer() {
        val cache = Cache()
        val (inFlight, release) = held(cache, 1)
        SuggestedOrderRepository.retire() // A → B
        SuggestedOrderRepository.retire() // B → A (released)
        assertNull(SuggestedOrderRepository.load(outlet, day, cache, 2) { throw ConvexFunctionError("Forbidden") }.order)
        release.countDown()
        val late = inFlight.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertNull(late.order)
        assertNull(cache.rows.getValue("$day|$outlet").json)
        assertEquals(SuggestedOrderRepository.NOT_ALLOWED, SuggestedOrderRepository.load(outlet, day, cache, 3, offline).message)
        // Without any refusal: the old answer still is not saved after A → B → A.
        val clean = Cache()
        val (second, release2) = held(clean, 4)
        SuggestedOrderRepository.retire(); SuggestedOrderRepository.retire()
        release2.countDown()
        assertNull(second.get(5, java.util.concurrent.TimeUnit.SECONDS).order)
        assertTrue(clean.rows.isEmpty())
        // A request started in the current lifetime still works.
        assertNotNull(SuggestedOrderRepository.load(outlet, day, clean, 5) { text }.order)
    }

    /** Closing the call sheet: the answer still in flight is not saved. */
    @Test fun abandoningAnInFlightRequestDoesNotSaveIt() {
        val cache = Cache()
        val (inFlight, release) = held(cache, 1)
        SuggestedOrderRepository.abandon()
        release.countDown()
        inFlight.get(5, java.util.concurrent.TimeUnit.SECONDS)
        assertTrue(cache.rows.isEmpty())
    }

    @Test fun aLatchedRefusalIsPerStoreAndDay() {
        val cache = Cache()
        assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 1) { text }.order)
        SuggestedOrderRepository.load("other", day, cache, 2) { throw ConvexFunctionError(null) }
        assertNotNull(SuggestedOrderRepository.load(outlet, day, cache, 3, offline).order)
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
