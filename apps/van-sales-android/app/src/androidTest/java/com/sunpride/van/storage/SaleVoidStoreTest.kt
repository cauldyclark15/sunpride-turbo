package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.ledger.*
import com.sunpride.van.pos.*
import com.sunpride.van.printing.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

/** Real encrypted Room transactions. Test-only inputs; no live backend or printer. */
@RunWith(AndroidJUnit4::class)
class SaleVoidStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private lateinit var store: RoomVanStore
    private val scope = StoreScope("https://test.invalid|void-seller","void-device")
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val chunks = "k57prod0000000000000000000000002"
    private val outlet = "k57out00000000000000000000000001"
    @Before fun setup() = runBlocking {
        name = "van-void-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,"test-only-void-sqlcipher-key".toByteArray(),name)
        store = RoomVanStore(db,scope,clock = { at+10 })
        val o = JSONObject(FakeVanBackend.FIXTURE)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
        o.getJSONObject("load").put("status","posted")
        val lines = o.getJSONObject("load").getJSONArray("lines")
        for (i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase","10").put("damagedBase","1"))
            .put(JSONObject().put("productId",chunks).put("availableBase","5").put("damagedBase","2")))
        store.replaceBootstrap(o.toString())
        // Prices come through the bootstrap feed (SP-0129 fixture: juice ₱68.50, chunks ₱42.75 per PC).
        Unit
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }
    private suspend fun sale(payment: PaymentInput = PaymentInput("cash",40000), multi: Boolean = true) =
        store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,
            if (multi) listOf(CartLine(juice,3),CartLine(chunks,2)) else listOf(CartLine(juice,3)),payment),if (multi) 29100 else 20550)
    private suspend fun code(receipt: com.sunpride.van.data.SaleReceipt, reason: String = "wrong_items"): String {
        val p = store.policy.first()!!
        val sale = db.rows().saleRows(s,d).single { it.saleId == receipt.saleId }
        return VoidApprovalCodes.code(p.voidApproval!!.key!!,sale.tripId,receipt.receiptNumber,receipt.totalMinor,reason)
    }
    private suspend fun void(receipt: com.sunpride.van.data.SaleReceipt, reason: String = "wrong_items", note: String? = null) =
        store.voidSale(receipt.saleId,reason,note,code(receipt,reason))
    private suspend fun refused(expected: VoidProblem, block: suspend () -> Unit) {
        val failure = runCatching { block() }.exceptionOrNull()
        assertTrue("Expected VoidRefused, got $failure",failure is VoidRefused)
        assertEquals(expected,(failure as VoidRefused).problem)
    }
    /** All SQLite tables and all column values, including nulls. Stronger than row-count-only refusal proof. */
    private fun snapshot(): Map<String,List<List<String?>>> {
        val sql = db.openHelper.writableDatabase
        val tables = sql.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) } }
        return tables.associateWith { table -> sql.query("SELECT * FROM `$table` ORDER BY rowid").use { c ->
            buildList { while(c.moveToNext()) add((0 until c.columnCount).map { if(c.isNull(it)) null else c.getString(it) }) } } }
    }
    private suspend fun noApproval(threshold: Long = 999999) {
        val meta = db.rows().meta(s,d)!!
        val policy = JSONObject(meta.policyJson!!)
        policy.getJSONObject("voidApproval").put("thresholdMinor",threshold.toString()).put("key",JSONObject.NULL)
        db.rows().insertSyncMeta(meta.copy(policyJson = policy.toString()))
    }
    @Test fun voidRestoresExactlyTheSaleAndLeavesEveryOriginalFactByteIdentical() = runBlocking {
        val receipt = sale()
        val log = RoomReceiptPrintLog(db,scope)
        val original = log.begin(receipt.saleId,false,null) as BeginPrint.Go
        log.finish(original.attempt.printId,PrintOutcome.PRINTED) // Q10: already on paper.
        val before = snapshot()
        val deduction = db.rows().stockmovementRows(s,d)
        val outbox = db.rows().outboxRows(s,d).single()
        val result = void(receipt,note = "Wrong order")
        assertFalse(result.replay); assertTrue(result.approved); assertEquals(receipt.receiptNumber,result.receiptNumber)
        val after = snapshot()
        listOf("sale","sale_line","payment","sale_receipt","receipt_print","transaction_id","sequence_counter").forEach { assertEquals(it,before[it],after[it]) }
        assertEquals(deduction,db.rows().stockmovementRows(s,d).filter { it.type == "SALE" })
        assertEquals(outbox,db.rows().outboxRows(s,d).single { it.kind == SALE_KIND })
        assertEquals(listOf(juice to 10L,chunks to 5L),store.stock().map { it.productId to it.availableBase })
        assertEquals(listOf(1L,2L),store.stock().map { it.damagedBase })
        val row = db.rows().salevoidRows(s,d).single()
        assertEquals(result.voidId,row.voidId); assertEquals("Wrong order",row.note)
        assertEquals(4,UUID.fromString(row.voidId).version()); assertEquals(4,UUID.fromString(row.idempotencyKey).version())
        assertTrue(row.createdAt > outbox.createdAt)
        val reversals = db.rows().stockmovementRows(s,d).filter { it.type == "VOID" }
        assertEquals(listOf(juice to 3L,chunks to 2L),reversals.map { it.productId to it.quantityBase })
        assertTrue(reversals.all { it.movementId == "${row.idempotencyKey}:${it.productId}:available:VOID" && it.createdAt == row.createdAt && it.tripId == row.tripId && it.stockStatus == "available" && it.reason == "wrong_items" })
        val op = db.rows().outboxRows(s,d).single { it.kind == SALE_VOID_KIND }
        assertEquals(SALE_PARKED,op.status); assertEquals(row.idempotencyKey,op.clientRequestId)
        val json = JSONObject(op.operationJson); assertEquals(SALE_VOID_KIND,json.getString("kind"))
        val payload = json.getJSONObject("payload")
        assertEquals(receipt.saleId,payload.getString("saleId")); assertEquals(receipt.receiptNumber,payload.getString("receiptNumber"))
        assertEquals(outbox.clientRequestId,payload.getString("saleClientRequestId")); assertEquals("29100",payload.getString("totalMinor"))
        assertEquals("PHP",payload.getString("currency")); assertEquals("wrong_items",payload.getString("reasonCode"))
        assertEquals("Wrong order",payload.getString("note")); assertEquals(row.createdAt,payload.getLong("deviceTime"))
        assertEquals("supervisor_code",payload.getJSONObject("approval").getString("method")); assertEquals(code(receipt),payload.getJSONObject("approval").getString("code"))
        assertTrue(store.pending().isEmpty()); assertTrue(store.saleStockIssues().isEmpty()); Unit
    }
    @Test fun doubleTapReplaysWithoutWritingAndDifferentReasonIsRefused() = runBlocking {
        val receipt = sale(); val first = void(receipt)
        val before = snapshot()
        val replay = store.voidSale(receipt.saleId,"wrong_items",null,null)
        assertEquals(first.copy(replay = true),replay); assertEquals(before,snapshot())
        refused(VoidProblem.ALREADY_VOIDED) { void(receipt,"wrong_payment") }
        assertEquals(before,snapshot()); Unit
    }
    @Test fun simultaneousDoubleTapAppendsOnce() = runBlocking {
        val receipt = sale(); val code = code(receipt)
        val results = (1..2).map { async(Dispatchers.IO) { store.voidSale(receipt.saleId,"wrong_items",null,code) } }.awaitAll()
        assertEquals(1,results.count { it.replay }); assertEquals(1,db.rows().salevoidRows(s,d).size)
        assertEquals(2,db.rows().stockmovementRows(s,d).count { it.type == "VOID" }); assertTrue(store.saleStockIssues().isEmpty()); Unit
    }
    @Test fun wrongCodeWritesNothingInAnyTable() = runBlocking {
        val receipt = sale(); val before = snapshot()
        val wrong = code(receipt,"wrong_payment")
        refused(VoidProblem.CODE_WRONG) { store.voidSale(receipt.saleId,"wrong_items",null,wrong) }
        assertEquals(before,snapshot()); assertEquals(before.mapValues { it.value.size },snapshot().mapValues { it.value.size }); Unit
    }
    @Test fun codeIsNotNeededBelowTheConfiguredThreshold() = runBlocking {
        val receipt = sale(); noApproval()
        val result = store.voidSale(receipt.saleId,"wrong_items",null,null)
        assertFalse(result.approved)
        val row = db.rows().salevoidRows(s,d).single(); assertEquals("none",row.approvalMethod); assertNull(row.approvalCode)
        val p = JSONObject(db.rows().outboxRows(s,d).single { it.kind == SALE_VOID_KIND }.operationJson).getJSONObject("payload")
        assertEquals("none",p.getJSONObject("approval").getString("method")); assertFalse(p.getJSONObject("approval").has("code")); assertFalse(p.has("note"))
        assertTrue(store.saleStockIssues().isEmpty()); Unit
    }
    @Test fun heldPartitionRefusesEvenAnOtherwiseIdempotentReplay() = runBlocking {
        val receipt = sale(); val code = code(receipt); store.hold(); val before = snapshot()
        refused(VoidProblem.HELD) { store.voidSale(receipt.saleId,"wrong_items",null,code) }; assertEquals(before,snapshot()); Unit
    }
    @Test fun anotherScopeOrTripCannotVoidTheSale() = runBlocking {
        val receipt = sale()
        val other = RoomVanStore(db,StoreScope("another|seller",d))
        db.rows().insertSyncMeta(SyncMetaRow("another|seller",d))
        val before = snapshot()
        refused(VoidProblem.SALE_NOT_FOUND) { other.voidSale(receipt.saleId,"wrong_items",null,null) }
        assertEquals(before,snapshot())
        val trip = db.rows().trip(s,d)!!; db.rows().clearTrip(s,d); db.rows().insertTrip(trip.copy(tripId = "another-trip"))
        val changed = snapshot()
        refused(VoidProblem.NOT_THIS_TRIP) { store.voidSale(receipt.saleId,"wrong_items",null,null) }; assertEquals(changed,snapshot()); Unit
    }
    @Test fun missingApprovalAndInvalidReasonOrNoteWriteNothing() = runBlocking {
        val receipt = sale(); val before = snapshot()
        refused(VoidProblem.REASON_REQUIRED) { store.voidSale(receipt.saleId,"delete",null,null) }
        refused(VoidProblem.NOTE_REQUIRED) { store.voidSale(receipt.saleId,"other"," ",null) }
        refused(VoidProblem.NOTE_INVALID) { store.voidSale(receipt.saleId,"wrong_items","bad\n",null) }
        refused(VoidProblem.CODE_REQUIRED) { store.voidSale(receipt.saleId,"wrong_items",null,"123") }
        assertEquals(before,snapshot())
        noApproval(threshold = 0)
        val unconfigured = snapshot()
        refused(VoidProblem.APPROVAL_UNAVAILABLE) { store.voidSale(receipt.saleId,"wrong_items",null,"12345678") }
        assertEquals(unconfigured,snapshot()); Unit
    }
    @Test fun creditAndPaymentReferenceAreReleasedWithoutChangingPaymentEvidence() = runBlocking {
        val credit = sale(PaymentInput("credit"),multi = false)
        assertEquals(mapOf(outlet to 20550L),store.paymentFacts().creditUsedMinor)
        void(credit); assertTrue(store.paymentFacts().creditUsedMinor.isEmpty())
        val check = sale(PaymentInput("check",null,"BDO 123"),multi = false)
        assertTrue(store.paymentFacts().usedReferences.contains(PaymentReference.key("check","BDO 123")))
        val payments = db.rows().paymentRows(s,d)
        void(check); assertTrue(store.paymentFacts().usedReferences.isEmpty()); assertEquals(payments,db.rows().paymentRows(s,d))
        sale(PaymentInput("check",null,"BDO 123"),multi = false) // same reference really can pay another sale.
        assertTrue(store.saleStockIssues().isEmpty()); Unit
    }
    @Test fun voidCannotBeWrittenAsAStandaloneLocalMovement() = runBlocking {
        val before = snapshot()
        val failure = runCatching { store.recordLocalMovement(MovementType.VOID,juice,StockStatus.available,1,"wrong_items",UUID.randomUUID().toString()) }.exceptionOrNull()
        assertTrue(failure is IllegalArgumentException); assertEquals(before,snapshot()); Unit
    }
    @Test fun printLogOffersOnlyVoidSlipsAndCapsFurtherCopies() = runBlocking {
        val receipt = sale(); val log = RoomReceiptPrintLog(db,scope)
        val original = log.begin(receipt.saleId,false,null) as BeginPrint.Go; log.finish(original.attempt.printId,PrintOutcome.PRINTED)
        void(receipt)
        val first = log.begin(receipt.saleId,false,null) as BeginPrint.Go
        assertEquals(PrintKind.VOID,first.attempt.kind); assertEquals(1,first.attempt.copyNumber); assertTrue(first.void!!.approved)
        assertEquals("wrong_items",first.void.reasonCode); assertFalse(SaleReceiptDocuments.build(first.receipt,first.header,first.attempt,at,void = first.void).isReprint)
        log.finish(first.attempt.printId,PrintOutcome.PRINTED)
        assertEquals(BeginPrint.Refused(PrintRefusal.ALREADY_PRINTED),log.begin(receipt.saleId,false,null))
        repeat(ReprintRules.MAX_REPRINTS) { val copy = log.begin(receipt.saleId,true,"office_copy") as BeginPrint.Go
            assertEquals(PrintKind.VOID,copy.attempt.kind); assertNull(copy.attempt.reason); log.finish(copy.attempt.printId,PrintOutcome.PRINTED) }
        assertEquals(BeginPrint.Refused(PrintRefusal.LIMIT_REACHED),log.begin(receipt.saleId,true,null))
        val saved = log.savedSales().single(); assertNotNull(saved.void); assertTrue(saved.printed); assertTrue(saved.voidSlipPrinted); assertEquals(0,saved.voidSlipsLeft); Unit
    }
    @Test fun failureMidVoidTransactionRollsBackEveryTable() = runBlocking {
        val receipt = sale(); val before = snapshot()
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_void BEFORE INSERT ON outbox WHEN NEW.kind='sale.void' BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching { void(receipt) }.isFailure)
        assertEquals(before,snapshot()); assertTrue(store.saleStockIssues().isEmpty())
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_void")
        assertFalse(void(receipt).replay); Unit
    }
    @Test fun checkerFindsMissingWrongAndOrphanReversals() = runBlocking {
        val receipt = sale(); void(receipt)
        val row = db.rows().stockmovementRows(s,d).first { it.type == "VOID" }
        db.openHelper.writableDatabase.execSQL("DELETE FROM stock_movement WHERE movementId=?",arrayOf(row.movementId))
        assertEquals(listOf("missing_reversal"),store.saleStockIssues().map { it.code })
        db.rows().insertMovement(row.copy(quantityBase = row.quantityBase+1))
        assertEquals(listOf("wrong_reversal"),store.saleStockIssues().map { it.code })
        db.rows().insertMovement(row.copy(movementId = "orphan",clientRequestId = UUID.randomUUID().toString()))
        assertEquals(setOf("wrong_reversal","reversal_without_void"),store.saleStockIssues().map { it.code }.toSet()); Unit
    }
    @Test fun corruptReversalIsDetectedBeforeCommitAndRolledBack() = runBlocking {
        val receipt = sale(); val before = snapshot()
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER corrupt_void AFTER INSERT ON stock_movement WHEN NEW.type='VOID' BEGIN UPDATE stock_movement SET quantityBase=1 WHERE movementId=NEW.movementId; END")
        assertTrue(runCatching { void(receipt) }.isFailure); assertEquals(before,snapshot()); Unit
    }
    @Test fun databaseUniquenessRefusesASecondVoidEvenOutsideTheCommand() = runBlocking {
        val receipt = sale(); void(receipt); val before = snapshot()
        val row = db.rows().salevoidRows(s,d).single()
        assertTrue(runCatching { db.rows().insertSaleVoid(row.copy(voidId = UUID.randomUUID().toString(),idempotencyKey = UUID.randomUUID().toString())) }.isFailure)
        assertEquals(before,snapshot()); Unit
    }
    /** VAN-019 x VAN-021: stock can never come back twice through a return plus a void of the same sale. */
    @Test fun aReturnedSaleCannotBeVoidedAndAVoidedSaleCannotTakeAReturn() = runBlocking {
        val returns = ReturnStore(store)
        val returned = sale()
        returns.commit(ReturnRequest(UUID.randomUUID().toString(),outlet,returned.saleId,
            listOf(ReturnLineInput(juice,"PC",1,"wrong_item",ReturnDisposition.RESELLABLE)),null))
        val before = snapshot()
        refused(VoidProblem.SALE_HAS_RETURNS) { void(returned) }
        assertEquals(before,snapshot())
        val voided = sale()
        void(voided)
        assertTrue(returns.sales().none { it.saleId == voided.saleId })
        assertTrue(returns.sales().any { it.saleId == returned.saleId })
        val failure = runCatching { returns.commit(ReturnRequest(UUID.randomUUID().toString(),outlet,voided.saleId,
            listOf(ReturnLineInput(juice,"PC",1,"wrong_item",ReturnDisposition.RESELLABLE)),null)) }.exceptionOrNull()
        assertTrue("expected ReturnRefused, got $failure",failure is ReturnRefused)
        assertTrue((failure as ReturnRefused).issues.any { it.problem == ReturnProblem.UNKNOWN_SALE })
        assertTrue(store.saleStockIssues().isEmpty())
    }
}
