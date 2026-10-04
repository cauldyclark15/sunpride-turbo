package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CallSheetPayloadTest {
    private val scope = StoreScope("issuer|person", "d", "s")
    private fun fixture() = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
        .bufferedReader().use { it.readText() }
    private fun sheet() = BootstrapCodec.page(fixture()).callSheets.single()
    private fun snapshot() = BootstrapCodec.snapshot(listOf(BootstrapCodec.page(fixture())))
    private fun checkIn() = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null,
        "planned-1", "outlet-1", emptyList(), null, null, null, null, null, at = 100)
    private fun activity(check: IntentRow, value: JSONObject = CallSheetPayload.activity(sheet(),
        listOf(CallSheetDraftLine("product-1", order = "0")))) = VisitIntentFactory.create(scope,
        "visit.activity", check.clientVisitId, check.requestId, check.requestId, null, "outlet-1",
        emptyList(), null, null, null, null, null, at = 100, callSheet = value)
    private suspend fun ready() = FakeFieldStore(scope).also {
        it.swap(it.stage(snapshot()), "cursor", 1000, 1000)
    }
    @Test fun onlyTouchedLinesAndEveryNullableMeasureAreSerialized() {
        val activity = CallSheetPayload.activity(sheet(), listOf(CallSheetDraftLine("product-1", order = "24"),
            CallSheetDraftLine("product-2")))
        val lines = activity.getJSONArray("lines")
        assertEquals(1, lines.length())
        val line = lines.getJSONObject(0)
        assertEquals(24, line.getInt("order"))
        assertEquals(7, line.length())
        CallSheetPayload.measures.drop(1).forEach { key ->
            assertTrue(line.has(key)); assertEquals(JSONObject.NULL, line.get(key))
        }
        assertFalse(activity.has("week")); assertFalse(activity.has("serviceDate"))
    }
    @Test fun zeroAndMillionAreValidNotBlank() {
        val line = CallSheetPayload.activity(sheet(), listOf(CallSheetDraftLine("product-2",
            beginningInventory = "0", endInventory = "1000000"))).getJSONArray("lines").getJSONObject(0)
        assertEquals(0, line.getInt("beginningInventory")); assertEquals(1_000_000, line.getInt("endInventory"))
        assertTrue(line.isNull("order"))
    }
    @Test fun negativeNonIntegerAndOverflowRejectedWithoutCoercion() {
        for (text in listOf("-1", "1.0", "1.5", "1e3", "+1", "1000001", "999999999999999999999", "abc")) {
            assertThrows(IllegalArgumentException::class.java) {
                CallSheetPayload.activity(sheet(), listOf(CallSheetDraftLine("product-1", order = text)))
            }
        }
    }
    @Test fun emptyAndUntouchedSaveRefused() {
        for (drafts in listOf(emptyList(), listOf(CallSheetDraftLine("product-1")),
            listOf(CallSheetDraftLine("product-1", take = "   ")))) {
            assertThrows(IllegalArgumentException::class.java) { CallSheetPayload.activity(sheet(), drafts) }
        }
    }
    @Test fun unknownAndDuplicateProductsRefused() {
        for (drafts in listOf(listOf(CallSheetDraftLine("other", order = "1")),
            listOf(CallSheetDraftLine("product-1", order = "1"), CallSheetDraftLine("product-1", take = "2")))) {
            assertThrows(IllegalArgumentException::class.java) { CallSheetPayload.activity(sheet(), drafts) }
        }
    }
    @Test fun wireValidatorRejectsMissingNullableKeysAndTypedDecimals() {
        val base = CallSheetPayload.activity(sheet(), listOf(CallSheetDraftLine("product-1", order = "1")))
        val missing = JSONObject(base.toString())
        missing.getJSONArray("lines").getJSONObject(0).remove("take")
        assertThrows(IllegalArgumentException::class.java) { CallSheetPayload.validate(missing, sheet()) }
        for (value in listOf<Any>(-1, 1.5, "1", 1_000_001)) {
            val invalid = JSONObject(base.toString())
            invalid.getJSONArray("lines").getJSONObject(0).put("order", value)
            assertThrows(IllegalArgumentException::class.java) { CallSheetPayload.validate(invalid, sheet()) }
        }
    }
    @Test fun hundredLinesAcceptedButHundredAndOneRejected() {
        val products = (1..101).map { CallSheetProduct("p$it", "", "", "", null, null) }
        val large = sheet().copy(lines = products)
        val drafts = products.map { CallSheetDraftLine(it.productId, take = "1") }
        assertEquals(100, CallSheetPayload.activity(large.copy(lines = products.take(100)), drafts.take(100))
            .getJSONArray("lines").length())
        assertThrows(IllegalArgumentException::class.java) { CallSheetPayload.activity(large, drafts) }
    }
    @Test fun publishedPushFixturePassesPayloadValidation() {
        val text = javaClass.classLoader!!.getResourceAsStream("push-call-sheet-request.json")!!
            .bufferedReader().use { it.readText() }
        val fixtureActivity = JSONObject(text).getJSONArray("operations").getJSONObject(0)
            .getJSONObject("payload").getJSONObject("activity")
        CallSheetPayload.validate(fixtureActivity, sheet())
    }
    @Test fun fakeStoreGenerationPromotionMatchesRoomVisibility() = runBlocking {
        val store = ready()
        val old = store.callSheet("outlet-1")
        val generation = store.stage(snapshot().copy(callSheets = listOf(sheet().copy(revision = 3))))
        assertEquals(old, store.callSheet("outlet-1"))
        store.swap(generation, "new", 1000, 1000)
        assertEquals(3L, store.callSheet("outlet-1")!!.revision)
        store.swap(store.stage(snapshot().copy(callSheets = emptyList())), "old-server", 1000, 1000)
        assertNull(store.callSheet("outlet-1"))
    }
    @Test fun fakeStoreRejectsNoSetupProductTamperingAndWrongScopeAtomically() = runBlocking {
        val store = ready(); val check = checkIn(); store.enqueue(check, 100)
        val row = activity(check)
        val bad = JSONObject(row.serializedOperation)
        bad.getJSONObject("payload").getJSONObject("activity").getJSONArray("lines").getJSONObject(0).put("productId", "not-allowed")
        assertThrows(IllegalArgumentException::class.java) { runBlocking {
            store.enqueue(row.copy(serializedOperation = bad.toString()), 100)
        } }
        assertEquals(1, store.history().size)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.enqueue(row.copy(account = "other"), 100) } }
        store.swap(store.stage(snapshot().copy(callSheets = emptyList())), "no-setup", 1000, 1000)
        assertThrows(IllegalStateException::class.java) { runBlocking { store.enqueue(row, 100) } }
        assertEquals(1, store.history().size)
        Unit
    }
    @Test fun fakeStoreMonotonicOrderingLeaseAndAckBeforeDoneMatchRoom() = runBlocking {
        val store = ready(); val check = checkIn(); store.enqueue(check, 100)
        val first = activity(check); val second = activity(check)
        store.enqueue(first, 100); store.enqueue(second, 100)
        assertEquals(listOf(100L, 101L, 102L), store.history().map { it.first.createdAt })
        store.markSending(listOf(first.requestId)); store.recordAck(first.requestId, "activity-1", "[]", 200)
        assertEquals("done", store.history()[1].second.state)
        assertNotNull(store.ack(first.requestId))
        store.recordAck(first.requestId, "activity-1", "[]", 200)
        assertThrows(IllegalStateException::class.java) { runBlocking { store.recordAck(first.requestId, "different", "[]", 200) } }
        assertThrows(IllegalStateException::class.java) { runBlocking { store.enqueue(activity(check), 1000) } }
        store.holdForReview()
        assertThrows(IllegalStateException::class.java) { runBlocking { store.enqueue(activity(check), 100) } }
        assertEquals(first.serializedOperation, store.intent(first.requestId)!!.serializedOperation)
        Unit
    }
}
