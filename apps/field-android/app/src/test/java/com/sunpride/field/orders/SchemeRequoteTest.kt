package com.sunpride.field.orders

import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** FLD-120: a re-sync re-quotes the scheme window; that alone is not a price change. */
class SchemeRequoteTest {
    private val scope = StoreScope("test", "device", "scope")
    private val list = OrderPriceList("sample", "SAMPLE-GT", "General trade", "PHP", true)
    private fun context(quotedAt: Long, promotions: JSONArray = JSONArray()) = JSONObject()
        .put("engineVersion", 1).put("outletId", "outlet-1").put("accountLinked", false)
        .put("quotedAt", quotedAt).put("validUntil", 9_000_000_000_000L).put("channelKey", "gt")
        .put("products", JSONArray()).put("prices", JSONArray().put(JSONObject().put("productId", "product-1")
            .put("uom", "PC").put("priceListId", JSONObject.NULL).put("unitPriceCentavos", 4525)))
        .put("promotions", promotions).put("authority", JSONArray()).toString()
    private fun terms(schemes: String) = OrderTerms("outlet-1", list, listOf(OrderUnit("product-1", "PC", 4525)), schemes)
    private fun snapshot(terms: OrderTerms): ScopedSnapshot {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
            .bufferedReader().use { it.readText() }
        val s = BootstrapCodec.snapshot(listOf(BootstrapCodec.page(text)))
        return s.copy(outlets = s.outlets.map { item ->
            item.copy(json = JSONObject(item.json).put("orderTerms", OrderTermsCodec.encode(terms)).toString())
        })
    }

    @Test fun requotedWindowAfterSyncIsNotAPriceChangeButChangedPromotionsAre() = runBlocking {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot(terms(context(1_000)))), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val start = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, "planned-1", "outlet-1",
            emptyList(), null, null, null, null, null, at = 100)
        store.enqueue(start, 100)
        val draft = OrderDraftRules.build(store, null, start.clientVisitId, start.requestId, listOf("product-1" to 2), 2_000)
        // Background sync after saving: same prices and promotions, new quote time.
        store.swap(store.stage(snapshot(terms(context(5_000)))), "cursor2", Long.MAX_VALUE, Long.MAX_VALUE)
        OrderDraftRules.validate(store, draft, null)
        assertTrue(OrderSubmission.checks(store, draft, 6_000).none { it.problem == OrderDraftFailure.Code.PRICES_CHANGED.text })
        // A real commercial change still blocks until saved again.
        val promo = JSONArray().put(JSONObject().put("id", "p").put("code", "P").put("name", "New offer"))
        store.swap(store.stage(snapshot(terms(context(5_000, promo)))), "cursor3", Long.MAX_VALUE, Long.MAX_VALUE)
        val failure = runCatching { OrderDraftRules.validate(store, draft, null) }.exceptionOrNull() as? OrderDraftFailure
        assertEquals(OrderDraftFailure.Code.PRICES_CHANGED, failure?.code)
        assertTrue(OrderDraftRules.sameSchemeTerms(context(1), context(2)))
        assertFalse(OrderDraftRules.sameSchemeTerms(context(1), null))
    }
}
