package com.sunpride.van.ui

import com.sunpride.van.pos.CashReconciliationRules
import com.sunpride.van.pos.CountOfficeRules
import com.sunpride.van.pos.StockCountLine
import com.sunpride.van.pos.StockReconciliationRules
import com.sunpride.van.pos.StockVarianceSummary
import com.sunpride.van.storepos.StoreStockRules
import com.sunpride.van.sync.SyncHealth
import com.sunpride.van.sync.V2VanCodec
import com.sunpride.van.sync.VanBootstrapCodec
import com.sunpride.van.vanday.AcceptCount
import com.sunpride.van.vanday.LoadAccept
import com.sunpride.van.vanday.SentLine
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** r6van6 (SP-0169): VAN-079, POS-044, VAN-014, VAN-086. */
class VanR6Van6Test {
    private fun op(type: String, id: String) = JSONObject().put("clientOpId", id).put("opType", type)
    private fun answer(type: String, id: String, code: String, retryable: Boolean) = JSONObject().put("version", 2).put("results",
        JSONArray().put(JSONObject().put("clientOpId", id).put("opType", type).put("status", "rejected").put("code", code).put("retryable", retryable)))

    // POS-044: "Receive all shipped" sends the office's field names, quantities as whole-number strings.
    @Test fun receiveAllShippedSendsTheOfficeFields() {
        val lines = StoreStockRules.receiveAllShipped(JSONArray().put(JSONObject().put("lineId", "L1").put("quantityBase", "24").put("name", "Beef")))
        val line = lines.getJSONObject(0)
        assertEquals("24", line.get("receivedGoodBase"))
        assertEquals("0", line.get("receivedDamagedBase"))
        assertEquals("0", line.get("receivedHoldBase"))
        assertFalse(line.has("receivedBase"))
        assertThrows(IllegalArgumentException::class.java) {
            StoreStockRules.receiveAllShipped(JSONArray().put(JSONObject().put("lineId", "L1").put("quantityBase", "2.5")))
        }
    }

    // POS-044: the shared fixture is exactly what the app's builders produce (the API suite runs it through the office).
    @Test fun phoneQuantityPayloadsMatchTheOfficeContract() {
        val root = JSONObject(checkNotNull(javaClass.getResourceAsStream("/phone-quantity-wire.json")).bufferedReader().use { it.readText() })
        val product = "33333333-3333-4333-8333-333333333333"
        fun same(expected: Any, actual: Any) = assertEquals(expected.toString(), actual.toString())
        same(root.getJSONObject("store.receive").getJSONArray("lines"), StoreStockRules.receiveAllShipped(JSONArray()
            .put(JSONObject().put("lineId", "11111111-1111-4111-8111-111111111111").put("quantityBase", "24"))
            .put(JSONObject().put("lineId", "22222222-2222-4222-8222-222222222222").put("quantityBase", "0"))))
        same(root.getJSONObject("store.count").getJSONArray("lines").getJSONObject(0), StoreStockRules.countLine(JSONObject().put("productId", product),
            JSONObject().put("lotId", JSONObject.NULL).put("stockStatus", "available").put("version", "7"), 12L))
        val sent = SentLine(product, "SRD", "Sardines", null, null, null, 48L, 48L, null, false)
        same(root.getJSONObject("load.accept"), LoadAccept.payload("44444444-4444-4444-8444-444444444444", "55555555-5555-4555-8555-555555555555",
            listOf(sent), mapOf(sent.key to AcceptCount(47L, "short_loaded")), null, 1794540570000L))
        same(root.getJSONObject("stock.reconcile").getJSONArray("lines"), JSONArray(listOf(
            StockCountLine(product, StockCountLine.AVAILABLE, 198L, 197L, "missing"), StockCountLine(product, StockCountLine.DAMAGED, 2L, 2L, null))
            .map(StockReconciliationRules::wireLine)))
        same(root.getJSONObject("cash.reconcile").getJSONArray("counts"), CashReconciliationRules.wireCounts(mapOf(100000L to 11L, 50000L to 1L, 1L to 1L, 500L to 0L)))
    }

    // VAN-079: a stock count sent while a damage waits for a supervisor stays queued; a stock_conflict is a refusal.
    @Test fun stockCountWaitingForADamageDecisionIsKept() {
        val r = V2VanCodec.results(answer("stock.reconcile", "s1", "evidence_pending_review", true), listOf(op("stock.reconcile", "s1"))).single()
        assertEquals("waiting", r.status)
        assertEquals(CountOfficeRules.WAITING_DAMAGE_CODE, r.code)
        val refused = V2VanCodec.results(answer("stock.reconcile", "s2", "stock_conflict", false), listOf(op("stock.reconcile", "s2"))).single()
        assertEquals("rejected", refused.status)
        assertEquals("stock_conflict", refused.code)
    }

    // VAN-079: plain reasons, and counting waits while a damage report is unsent or undecided.
    @Test fun countRefusalsAndDamageWaitsArePlain() {
        val stock = CountOfficeRules.refusal(CountOfficeRules.STOCK_KIND, "stock_conflict")
        assertTrue(stock, stock.startsWith("The office refused your stock count: the office's truck stock changed after your count"))
        assertTrue(stock.endsWith("Sync, then count the stock again."))
        val cash = CountOfficeRules.refusal(CountOfficeRules.CASH_KIND, "evidence_pending_review")
        assertEquals("The office refused your cash count: a damage report was waiting for a supervisor's decision. Count the cash again.", cash)
        assertFalse(CountOfficeRules.refusal(CountOfficeRules.STOCK_KIND, "weird_code").contains("weird"))
        val records = JSONArray().put(JSONObject().put("status", "approved")).put(JSONObject().put("status", "rejected"))
        assertNull(CountOfficeRules.damageWaiting(records, false))
        assertTrue(CountOfficeRules.damageWaiting(JSONArray(records.toString()).put(JSONObject().put("status", "pending_approval")), false)!!
            .startsWith("A damage report is waiting for a supervisor's decision."))
        assertEquals("A damage report is not sent to the office yet. Sync first, then count the stock.", CountOfficeRules.damageWaiting(null, true))
    }

    // VAN-079 (P3): the wrong-code answer is next to the Save button, ahead of the to-do line and the totals.
    @Test fun stockCountTapAnswerIsInTheFooter() {
        val wrong = VanRules.stockMessage(com.sunpride.van.pos.StockProblem.CODE_WRONG)
        assertEquals(wrong, stockCountFooter(true, wrong, null, listOf("Sardines · sellable reason"), StockVarianceSummary(1, 1L, 0L)))
        assertEquals("1 lines differ · 1 short · 0 over", stockCountFooter(true, null, null, emptyList(), StockVarianceSummary(1, 1L, 0L)))
        assertEquals("Still to do: Sardines · sellable reason", stockCountFooter(true, null, null, listOf("Sardines · sellable reason"), null))
        assertEquals("wait", stockCountFooter(true, null, "wait", listOf("x"), null))
    }

    // VAN-086: a paused phone says so on Sync & posting, not "Last sync finished".
    @Test fun pausedPhoneSaysSyncIsPaused() {
        assertTrue(SyncHealth.healthLabel(SyncHealth.PAUSED_HEALTH).startsWith("Sync is paused"))
        assertEquals("Last sync finished", SyncHealth.healthLabel("synced"))
    }

    // VAN-014: the phone names the office's in-scope load approver; an older server still gives the supervisor.
    @Test fun loadDifferenceNamesWhoCanDecideIt() {
        val named = VanBootstrapCodec.handheld((JSONObject().put("supervisorName", "Sample Tomas Supervisor").put("loadApproverName", "Sample Maria Sales Manager")))
        assertEquals("Load difference sent to Sample Maria Sales Manager. You will be told here when it is decided.",
            UserMessages.loadDifferenceSent(named.loadApproverName))
        val nobody = VanBootstrapCodec.handheld((JSONObject().put("supervisorName", "Sample Tomas Supervisor").put("loadApproverName", JSONObject.NULL)))
        assertEquals(UserMessages.LOAD_DIFFERENCE_SENT, UserMessages.loadDifferenceSent(nobody.loadApproverName))
        val older = VanBootstrapCodec.handheld((JSONObject().put("supervisorName", "Sample Tomas Supervisor")))
        assertEquals("Sample Tomas Supervisor", older.loadApproverName)
    }
}
