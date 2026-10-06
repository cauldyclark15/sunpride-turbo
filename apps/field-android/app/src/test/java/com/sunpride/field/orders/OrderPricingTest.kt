package com.sunpride.field.orders

import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.saveOrderDraftIn
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** SP-0088: mirrors iOS OrderPricingTests; all credit decisions are advisory. */
class OrderPricingTest {
    private val scope = StoreScope("test", "device", "scope")
    private val list = OrderPriceList("sample", "SAMPLE-GT", "General trade", "PHP", true)
    private fun terms(price: Long? = 4525, caseUnit: Boolean = true) = OrderTerms("outlet-1", list,
        listOf(OrderUnit("product-1", "PC", price), OrderUnit("product-2", "CAN", null)) +
            if (caseUnit) listOf(OrderUnit("product-1", "CS", 105325)) else emptyList())
    private fun snapshot(terms: OrderTerms?): ScopedSnapshot {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
            .bufferedReader().use { it.readText() }
        val s = BootstrapCodec.snapshot(listOf(BootstrapCodec.page(text)))
        return s.copy(outlets = s.outlets.map { item ->
            val o = JSONObject(item.json)
            if (terms != null) o.put("orderTerms", OrderTermsCodec.encode(terms))
            item.copy(json = o.toString())
        })
    }
    private suspend fun ready(terms: OrderTerms? = terms()): Pair<FakeFieldStore, IntentRow> {
        val store = FakeFieldStore(scope)
        store.swap(store.stage(snapshot(terms)), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val start = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, "planned-1", "outlet-1",
            emptyList(), null, null, null, null, null, at = 100)
        store.enqueue(start, 100)
        return store to start
    }
    private suspend fun draft(price: Long? = 4525, quantity: Int = 2): OrderDraft {
        val (s, start) = ready(terms(price))
        return OrderDraftRules.build(s, null, start.clientVisitId, start.requestId, listOf("product-1" to quantity), 200)
    }
    private fun summary(limit: Long?, open: Long? = null, availability: String = "available") = AccountSummary(
        "outlet-1", "2026-10-02", availability, limit, null, open?.let { AccountOpenOrders(1, it) })
    private suspend fun assertPricesChanged(store: FieldStore, draft: OrderDraft) {
        val failure = runCatching { OrderDraftRules.validate(store, draft, null) }.exceptionOrNull() as? OrderDraftFailure
        assertEquals(OrderDraftFailure.Code.PRICES_CHANGED, failure?.code)
    }
    @Test fun unitSwitchSnapshotsPriceAndKeepsOneLinePerProductAndWireUnchanged() = runBlocking {
        val (s, start) = ready()
        val first = saveOrderDraftIn(s, null, start.clientVisitId, start.requestId, listOf("product-1" to 2), 200)
        assertEquals("PC", first.lines.single().uom); assertEquals(4525L, first.lines.single().unitPriceMinor)
        assertEquals(list, first.priceList)
        val switched = saveOrderDraftIn(s, first.draftId, start.clientVisitId, start.requestId,
            listOf("product-1" to 3), 300, mapOf("product-1" to "CS"))
        assertEquals(1, switched.lines.size); assertEquals("CS", switched.lines.single().uom)
        assertEquals(105325L, switched.lines.single().unitPriceMinor)
        assertEquals(switched, OrderDraftCodec.decode(OrderDraftCodec.encode(switched)))
        val next = OrderDraftRules.build(s, switched, start.clientVisitId, start.requestId, listOf("product-1" to 4), 400)
        assertEquals("CS", next.lines.single().uom)
        val activity = OrderSubmission.activity(switched); OrderSubmission.validateActivity(activity)
        assertEquals(setOf("productId", "uom", "quantity"), activity.getJSONArray("lines").getJSONObject(0).keys().asSequence().toSet())
        assertFalse(activity.toString().contains("price") || activity.toString().contains("amount"))
        assertTrue(runCatching { OrderDraftRules.build(s, first, start.clientVisitId, start.requestId,
            listOf("product-1" to 2), 400, units = mapOf("product-1" to "PALLET")) }.isFailure)
        assertTrue(runCatching { OrderDraftRules.build(s, null, start.clientVisitId, start.requestId,
            listOf("product-1" to 2, "product-1" to 3), 400) }.isFailure)
        val sent = submitOrderDraftIn(s, scope, switched.draftId, start.requestId, 500)
        val wire = JSONObject(s.history().last().first.serializedOperation).getJSONObject("payload").getJSONObject("activity")
        assertTrue(OrderSubmission.sameActivity(activity, wire)); assertNotNull(sent.submittedRequestId)
    }
    @Test fun changedPriceRemovedUnitAndChangedPriceListAreStaleUntilSavedAgain() = runBlocking {
        val (s, start) = ready()
        val saved = saveOrderDraftIn(s, null, start.clientVisitId, start.requestId, listOf("product-1" to 2), 200)
        s.swap(s.stage(snapshot(terms(4600))), "next", Long.MAX_VALUE, Long.MAX_VALUE)
        assertPricesChanged(s, saved)
        assertEquals(1, OrderDraftRules.staleLines(saved, s.callSheet("outlet-1"), s.orderTerms("outlet-1")).size)
        assertTrue(OrderSubmission.checks(s, saved, 300).any { it.blocking && it.problem == OrderDraftFailure.Code.PRICES_CHANGED.text })
        val refreshed = saveOrderDraftIn(s, saved.draftId, start.clientVisitId, start.requestId, listOf("product-1" to 2), 300)
        assertEquals(4600L, refreshed.lines.single().unitPriceMinor)
        val cases = saveOrderDraftIn(s, refreshed.draftId, start.clientVisitId, start.requestId,
            listOf("product-1" to 2), 400, mapOf("product-1" to "CS"))
        s.swap(s.stage(snapshot(terms(caseUnit = false))), "next2", Long.MAX_VALUE, Long.MAX_VALUE)
        assertPricesChanged(s, cases)
        val reset = saveOrderDraftIn(s, cases.draftId, start.clientVisitId, start.requestId,
            listOf("product-1" to 2), 500, mapOf("product-1" to "PC"))
        s.swap(s.stage(snapshot(terms().copy(priceList = list.copy(id = "new")))), "next3", Long.MAX_VALUE, Long.MAX_VALUE)
        assertPricesChanged(s, reset)
        assertTrue(OrderDraftRules.staleLines(reset, s.callSheet("outlet-1"), s.orderTerms("outlet-1")).isEmpty())
        s.swap(s.stage(snapshot(null)), "legacy", Long.MAX_VALUE, Long.MAX_VALUE)
        assertPricesChanged(s, reset)
    }
    @Test fun oldDraftWithoutPriceSnapshotsStillDecodesAndUsesTheSetupUnit() = runBlocking {
        val (s, start) = ready(null)
        val saved = saveOrderDraftIn(s, null, start.clientVisitId, start.requestId, listOf("product-1" to 2), 200)
        val o = JSONObject(OrderDraftCodec.encode(saved)); o.remove("priceList")
        o.getJSONArray("lines").getJSONObject(0).remove("unitPriceMinor")
        val decoded = OrderDraftCodec.decode(o.toString())
        assertEquals(saved, decoded); assertNull(decoded.priceList); assertNull(decoded.lines.single().unitPriceMinor)
        OrderDraftRules.validate(s, decoded, null)
        assertEquals(listOf("PC"), OrderCatalog.of(s.callSheet("outlet-1")).first().units.map { it.uom })
    }
    @Test fun partialZeroAndAllPricedTotalsAndMoneyStayExact() = runBlocking {
        val d = draft().let { it.copy(lines = it.lines + OrderDraftLine("office", "U", "Office line", "CAN", 4)) }
        val t = OrderSubmission.totals(d)
        assertEquals(9050L, t.totalMinor); assertEquals("₱90.50", t.amountText)
        assertEquals("+ 1 line priced by the office", t.officeText); assertEquals("2 products · 2 PC · 4 CAN", t.text)
        assertEquals(9454L, OrderSubmission.totals(d.copy(lines = d.lines.map {
            if (it.productId == "office") it.copy(unitPriceMinor = 101) else it
        })).totalMinor)
        assertEquals(0L, OrderSubmission.totals(draft(0)).totalMinor)
        assertEquals("+ 1 line priced by the office", OrderSubmission.totals(draft(null)).officeText)
        assertEquals("+ 2 lines priced by the office", OrderSubmission.totals(d.copy(lines = d.lines.map { it.copy(unitPriceMinor = null) })).officeText)
        assertEquals("₱45.25 / CAN", OrderSubmission.unitPrice(4525, "CAN"))
        assertEquals("Priced by the office", OrderSubmission.unitPrice(null, "CAN"))
        assertEquals("₱1,234.50", OrderSubmission.money(123450)); assertEquals("₱0.00", OrderSubmission.money(0))
        assertEquals("₱0.01", OrderSubmission.money(1)); assertEquals("−₱0.01", OrderSubmission.money(-1))
        assertEquals("₱92,233,720,368,547,758.07", OrderSubmission.money(Long.MAX_VALUE))
        assertEquals("−₱92,233,720,368,547,758.08", OrderSubmission.money(Long.MIN_VALUE))
    }
    @Test fun withinCreditAtBoundaryAndOpenOrdersDefaultZero() = runBlocking {
        val d = draft()
        val c = OrderSubmission.creditCheck(d, summary(10000))
        assertEquals("Within the store's credit limit", c.label); assertEquals("₱9.50 left after this order", c.note)
        assertTrue(c.ok); assertFalse(c.blocking); assertFalse(c.warning)
        assertEquals("₱0.00 left after this order", OrderSubmission.creditCheck(d, summary(10000, 950)).note)
    }
    @Test fun overCreditNeverBlocksAndNoLimitWithheldOrAbsentAreInformation() = runBlocking {
        val d = draft()
        val c = OrderSubmission.creditCheck(d, summary(10000, 1000))
        assertEquals("Over the store's credit limit by ₱0.50. You can still send it; the office must approve.", c.note)
        assertTrue(c.warning); assertTrue(c.ok); assertFalse(c.blocking)
        assertEquals("No credit limit set for this store", OrderSubmission.creditCheck(d, summary(null)).note)
        for (summary in listOf(null, summary(null, availability = "withheld"), summary(10000).copy(outletId = "foreign"))) {
            val check = OrderSubmission.creditCheck(d, summary)
            assertEquals("Credit is checked by the office when the order arrives.", check.note)
            assertFalse(check.warning); assertFalse(check.blocking)
        }
    }
    @Test fun otherSubmittedOrdersCountOnceOnlyForThisOutletAndServiceDayAndExcludeThisOrder() = runBlocking {
        val d = draft(); val other = draft(quantity = 1).copy(submittedRequestId = UUID.randomUUID().toString())
        val c = OrderSubmission.creditCheck(d, summary(14000, 500), listOf(other, other,
            d.copy(submittedRequestId = "self"), draft(quantity = 99), other.copy(outletId = "other"),
            other.copy(serviceDate = "another")))
        assertEquals("Over the store's credit limit by ₱0.75. You can still send it; the office must approve.", c.note)
    }
    @Test fun reviewReadsCachedSummaryAndCountsOtherSubmittedDraftsWithoutBlockingSend() = runBlocking {
        val (s, start) = ready()
        val first = saveOrderDraftIn(s, null, start.clientVisitId, start.requestId, listOf("product-1" to 1), 200)
        val sent = submitOrderDraftIn(s, scope, first.draftId, start.requestId, 300)
        val current = saveOrderDraftIn(s, null, start.clientVisitId, start.requestId, listOf("product-1" to 2), 400)
        val cache = snapshot(terms()).let { snap -> snap.copy(outlets = snap.outlets.map { row ->
            row.copy(json = JSONObject(row.json).put("accountSummary", AccountSummaryCodec.encode(summary(14000, 500))).toString())
        }) }
        s.swap(s.stage(cache), "next", Long.MAX_VALUE, Long.MAX_VALUE)
        val checks = OrderSubmission.checks(s, current, 500)
        assertTrue(checks.all { it.ok || !it.blocking })
        val credit = checks.single { it.warning }
        assertEquals("Over the store's credit limit by ₱0.75. You can still send it; the office must approve.", credit.note)
        assertFalse(credit.blocking)
        assertNotNull(submitOrderDraftIn(s, scope, current.draftId, sent.submittedRequestId!!, 500).submittedRequestId)
    }
    @Test fun overflowAlwaysFallsBackWithoutTrappingOrBlocking() = runBlocking {
        val d = draft(Long.MAX_VALUE)
        assertNull(OrderSubmission.lineAmount(d.lines.single())); assertNull(OrderSubmission.totals(d).totalMinor)
        assertEquals("Amount too large to preview", OrderSubmission.totals(d).amountText)
        val sumOverflow = d.copy(lines = listOf(d.lines.single().copy(quantity = 1), d.lines.single().copy(quantity = 1)))
        assertNull(OrderSubmission.totals(sumOverflow).totalMinor)
        val regular = draft()
        for (check in listOf(OrderSubmission.creditCheck(d, summary(Long.MAX_VALUE)),
            OrderSubmission.creditCheck(regular, summary(10000, Long.MAX_VALUE), listOf(regular.copy(draftId = "other", submittedRequestId = "sent"))),
            OrderSubmission.creditCheck(regular, summary(Long.MAX_VALUE, -1)),
            OrderSubmission.creditCheck(regular, summary(0, Long.MAX_VALUE - 9049)))) {
            assertEquals("Credit is checked by the office when the order arrives.", check.note)
            assertFalse(check.blocking); assertFalse(check.warning)
        }
    }
}
