package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.pos.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

/** VAN-022 on real encrypted Room transactions. Test-only inputs; no live backend. */
@RunWith(AndroidJUnit4::class)
class CashReconciliationStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private lateinit var store: RoomVanStore
    private lateinit var cash: CashReconciliationStore
    private val scope = StoreScope("https://test.invalid|cash-seller","cash-device")
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val chunks = "k57prod0000000000000000000000002"
    private val outlet = "k57out00000000000000000000000001"
    @Before fun setup() = runBlocking {
        name = "van-cash-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,"test-only-cash-sqlcipher-key".toByteArray(),name)
        store = RoomVanStore(db,scope,clock = { at+10 })
        cash = CashReconciliationStore(store)
        val o = JSONObject(FakeVanBackend.FIXTURE)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
        o.getJSONObject("load").put("status","posted")
        val lines = o.getJSONObject("load").getJSONArray("lines")
        for (i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase","20").put("damagedBase","0"))
            .put(JSONObject().put("productId",chunks).put("availableBase","20").put("damagedBase","0")))
        store.replaceBootstrap(o.toString()); Unit
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }
    /** Juice ₱68.50, chunks ₱42.75 per PC (fixture price feed). */
    private suspend fun sale(payment: PaymentInput, juiceQty: Long = 3, total: Long = 20550) =
        store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(juice,juiceQty)),payment),total)
    private suspend fun void(receipt: com.sunpride.van.data.SaleReceipt) {
        val p = store.policy.first()!!
        store.voidSale(receipt.saleId,"customer_cancelled",null,VoidApprovalCodes.code(p.voidApproval!!.key!!,
            db.rows().trip(s,d)!!.tripId,receipt.receiptNumber,receipt.totalMinor,"customer_cancelled"))
    }
    private suspend fun code(expected: Long, declared: Long, reason: String) =
        CashApprovalCodes.code(store.policy.first()!!.cashReconciliation!!.key!!,db.rows().trip(s,d)!!.tripId,expected,declared,reason)
    private fun request(counts: Map<Long,Long>, expected: Long, reason: String? = null, note: String? = null, code: String? = null,
        id: String = UUID.randomUUID().toString()) = CashCountRequest(id,counts,reason,note,code,expected)
    private suspend fun refused(expected: CashProblem, block: suspend () -> Unit) {
        val failure = runCatching { block() }.exceptionOrNull()
        assertTrue("Expected CashRefused, got $failure",failure is CashRefused)
        assertEquals(expected,(failure as CashRefused).problem)
    }
    private fun snapshot(): Map<String,List<List<String?>>> {
        val sql = db.openHelper.writableDatabase
        val tables = sql.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) } }
        return tables.associateWith { table -> sql.query("SELECT * FROM `$table` ORDER BY rowid").use { c ->
            buildList { while(c.moveToNext()) add((0 until c.columnCount).map { if(c.isNull(it)) null else c.getString(it) }) } } }
    }

    @Test fun expectedCashCountsOnlyCashOfSalesNotVoidedAndAMatchingCountSavesWithoutAReason() = runBlocking {
        sale(PaymentInput("cash",30_000))                      // ₱205.50 cash, ₱94.50 change
        sale(PaymentInput("gcash",null,"GC 1"),1,6850)         // ₱68.50 GCash
        sale(PaymentInput("credit"),2,13700)                   // ₱137.00 on account
        val voided = sale(PaymentInput("cash",6850),1,6850); void(voided)
        val summary = cash.summary()!!
        assertTrue(summary.countable); assertNull(summary.saved)
        assertEquals(20550L,summary.expectation.expectedMinor); assertEquals(1,summary.expectation.cashSales)
        assertEquals(1,summary.expectation.voidedSales)
        assertEquals(listOf("gcash" to 6850L,"credit" to 13700L),summary.expectation.others.map { it.code to it.amountMinor })
        val before = snapshot()
        val result = cash.commit(request(mapOf(10_000L to 2L,500L to 1L,25L to 2L),20550,reason = "counting_error",note = " ok "))
        assertEquals(0L,result.varianceMinor); assertNull(result.reasonCode); assertEquals("ok",result.note); assertFalse(result.approved)
        val after = snapshot()
        listOf("sale","sale_line","payment","sale_void","stock_movement","sale_receipt").forEach { assertEquals(it,before[it],after[it]) }
        val row = db.rows().cashReconciliation(s,d,summary.tripId)!!
        assertEquals(20550L,row.expectedMinor); assertEquals(20550L,row.declaredMinor); assertEquals("none",row.approvalMethod); assertNull(row.approvalCode)
        val op = db.rows().outboxRows(s,d).single { it.kind == CASH_RECONCILE_KIND }
        assertEquals(SALE_PARKED,op.status); assertEquals(row.idempotencyKey,op.clientRequestId); assertTrue(op.createdAt > db.rows().outboxRows(s,d).filter { it.kind == SALE_KIND }.maxOf { it.createdAt })
        val p = JSONObject(op.operationJson).getJSONObject("payload")
        assertEquals("20550",p.getString("expectedMinor")); assertEquals("0",p.getString("varianceMinor")); assertEquals(1,p.getInt("voidedSales"))
        assertEquals(listOf("10000" to "2","500" to "1","25" to "2"),(0 until p.getJSONArray("counts").length()).map {
            p.getJSONArray("counts").getJSONObject(it).let { c -> c.getString("denominationMinor") to c.getString("count") } })
        assertFalse(p.has("reasonCode")); assertEquals("none",p.getJSONObject("approval").getString("method"))
        assertTrue(store.pending().isEmpty()); Unit
    }
    @Test fun aDifferenceAboveToleranceNeedsTheExactCodeAndRefusalsWriteNothing() = runBlocking {
        sale(PaymentInput("cash",30_000))
        val counts = mapOf(10_000L to 1L,2_000L to 2L)   // ₱140 counted vs ₱205.50 expected: ₱65.50 short
        val before = snapshot()
        refused(CashProblem.REASON_REQUIRED) { cash.commit(request(counts,20550)) }
        refused(CashProblem.CODE_REQUIRED) { cash.commit(request(counts,20550,"lost_or_stolen")) }
        refused(CashProblem.CODE_WRONG) { cash.commit(request(counts,20550,"lost_or_stolen",code = code(20550,14000,"counting_error"))) }
        refused(CashProblem.NOTE_REQUIRED) { cash.commit(request(counts,20550,"other",code = code(20550,14000,"other"))) }
        refused(CashProblem.EXPECTED_CHANGED) { cash.commit(request(counts,20000,"lost_or_stolen",code = code(20000,14000,"lost_or_stolen"))) }
        refused(CashProblem.COUNT_INVALID) { cash.commit(request(mapOf(300L to 1L),20550,"lost_or_stolen")) }
        assertEquals(before,snapshot())
        val result = cash.commit(request(counts,20550,"lost_or_stolen",code = code(20550,14000,"lost_or_stolen")))
        assertEquals(-6550L,result.varianceMinor); assertTrue(result.approved)
        val row = db.rows().cashReconciliation(s,d,db.rows().trip(s,d)!!.tripId)!!
        assertEquals("supervisor_code",row.approvalMethod); assertEquals(code(20550,14000,"lost_or_stolen"),row.approvalCode)
        Unit
    }
    @Test fun withinToleranceNeedsOnlyAReason() = runBlocking {
        sale(PaymentInput("cash",30_000))
        val result = cash.commit(request(mapOf(10_000L to 2L),20550,"change_error"))   // ₱5.50 short
        assertEquals(-550L,result.varianceMinor); assertFalse(result.approved); assertEquals("change_error",result.reasonCode); Unit
    }
    @Test fun oneCountPerTripReplaysTheSameTapAndThenSellingAndVoidingStop() = runBlocking {
        val kept = sale(PaymentInput("cash",30_000))
        val req = request(mapOf(10_000L to 2L,500L to 1L,25L to 2L),20550)
        val first = cash.commit(req); val before = snapshot()
        assertEquals(first.copy(replay = true),cash.commit(req)); assertEquals(before,snapshot())
        refused(CashProblem.ALREADY_COUNTED) { cash.commit(request(req.counts,20550)) }
        refused(CashProblem.ALREADY_COUNTED) { cash.commit(req.copy(counts = mapOf(10_000L to 3L))) }
        assertEquals(before,snapshot())
        // Database uniqueness holds even outside the command.
        val row = db.rows().cashReconciliation(s,d,db.rows().trip(s,d)!!.tripId)!!
        assertTrue(runCatching { db.rows().insertCashReconciliation(row.copy(reconciliationId = UUID.randomUUID().toString())) }.isFailure)
        // No sale and no void after the count: the approved expected cash cannot change.
        val failure = runCatching { sale(PaymentInput("cash",10_000),1,6850) }.exceptionOrNull()
        assertTrue("$failure",failure is CheckoutRefused && failure.issues.any { it.problem == CheckoutProblem.CASH_COUNTED })
        refused2(VoidProblem.CASH_COUNTED) { void(kept) }
        assertEquals(before,snapshot())
        assertTrue(store.cashCounted.first()); Unit
    }
    private suspend fun refused2(expected: VoidProblem, block: suspend () -> Unit) {
        val failure = runCatching { block() }.exceptionOrNull()
        assertTrue("Expected VoidRefused, got $failure",failure is VoidRefused); assertEquals(expected,(failure as VoidRefused).problem)
    }
    @Test fun simultaneousSavesAppendOnce() = runBlocking {
        sale(PaymentInput("cash",30_000))
        val req = request(mapOf(10_000L to 2L,500L to 1L,25L to 2L),20550)
        val results = (1..2).map { async(Dispatchers.IO) { cash.commit(req) } }.awaitAll()
        assertEquals(1,results.count { it.replay }); assertEquals(1,db.rows().outboxRows(s,d).count { it.kind == CASH_RECONCILE_KIND }); Unit
    }
    @Test fun heldPartitionAndUnstartedTripCannotCount() = runBlocking {
        sale(PaymentInput("cash",30_000))
        store.hold(); val before = snapshot()
        refused(CashProblem.HELD) { cash.commit(request(emptyMap(),20550,"lost_or_stolen")) }
        assertEquals(before,snapshot())
        assertFalse(cash.summary()!!.countable); Unit
    }
    @Test fun failureMidSaveRollsBackEveryTable() = runBlocking {
        sale(PaymentInput("cash",30_000)); val before = snapshot()
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_cash BEFORE INSERT ON outbox WHEN NEW.kind='cash.reconcile' BEGIN SELECT RAISE(ABORT,'injected'); END")
        val req = request(mapOf(10_000L to 2L,500L to 1L,25L to 2L),20550)
        assertTrue(runCatching { cash.commit(req) }.isFailure)
        assertEquals(before,snapshot()); assertFalse(store.cashCounted.first())
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_cash")
        assertFalse(cash.commit(req).replay); Unit
    }
}
