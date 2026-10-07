package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.*
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

/** VAN-024 against the real encrypted Room store: checklist from stored facts, atomic close, replay and freeze. */
@RunWith(AndroidJUnit4::class)
class TripCloseStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private lateinit var store: RoomVanStore
    private lateinit var close: TripCloseStore
    private val scope = StoreScope("https://test.invalid|close-seller","close-device")
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val outlet = "k57out00000000000000000000000001"
    private val closeId = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f"

    @Before fun setup() = runBlocking {
        name = "van-close-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,"test-only-close-sqlcipher-key".toByteArray(),name)
        store = RoomVanStore(db,scope,clock = { at + 10 })
        close = TripCloseStore(store)
        val o = JSONObject(FakeVanBackend.FIXTURE)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
        o.getJSONObject("load").put("status","posted")
        val load = o.getJSONObject("load").getJSONArray("lines")
        for (i in 0 until load.length()) load.getJSONObject(i).put("actualBase",load.getJSONObject(i).getString("expectedBase"))
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase","20").put("damagedBase","0")))
        store.replaceBootstrap(o.toString()); Unit
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }

    private fun snapshot(): Map<String,List<List<String?>>> {
        val sql = db.openHelper.writableDatabase
        val tables = sql.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        return tables.associateWith { table -> sql.query("SELECT * FROM `$table` ORDER BY rowid").use { c -> buildList { while(c.moveToNext()) add((0 until c.columnCount).map { if(c.isNull(it)) null else c.getString(it) }) } } }
    }
    private suspend fun refused(expected: CloseProblem, request: TripCloseRequest = TripCloseRequest(closeId,null,null,null)) {
        val before = snapshot()
        val failure = runCatching { close.commit(request) }.exceptionOrNull()
        assertTrue("Expected TripCloseRefused, got $failure",failure is TripCloseRefused); assertEquals(expected,(failure as TripCloseRefused).problem)
        assertEquals("a refused close writes nothing",before,snapshot())
    }
    private suspend fun sell(): SaleReceipt = store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(juice,1)),PaymentInput("cash",6850)),6850)
    /** ₱68.50 = 50 + 10 + 5 + 1 + 1 + 1 + 0.25 × 2. */
    private val cash6850 = mapOf(5_000L to 1L,1_000L to 1L,500L to 1L,100L to 3L,25L to 2L)
    private suspend fun countCash(counts: Map<Long,Long>, expected: Long, reason: String? = null) =
        CashReconciliationStore(store).commit(CashCountRequest(UUID.randomUUID().toString(),counts,reason,null,null,expected))
    private suspend fun countStock() = StockReconciliationStore(store).let { st ->
        st.commit(StockCountRequest(UUID.randomUUID().toString(),st.summary()!!.lines.map { StockCountLine(it.productId,it.status,it.expectedBase,it.expectedBase) }))
    }

    @Test fun checklistBlocksUntilCashAndStockAreCountedThenClosesAtomicallyWithAParkedOperation() = runBlocking {
        val first = close.summary()!!
        assertEquals(listOf(CloseStep.CASH_COUNTED,CloseStep.STOCK_COUNTED),first.checklist.blockers.map { it.step })
        refused(CloseProblem.CASH_NOT_COUNTED)
        val sale = sell()
        countCash(cash6850,6850)
        refused(CloseProblem.STOCK_NOT_COUNTED)
        countStock()
        // The sale's receipt never printed: an exception the seller must confirm.
        val summary = close.summary()!!
        assertTrue(summary.checklist.ready)
        assertEquals(listOf(CloseException(CloseExceptionKind.UNPRINTED_RECEIPTS,1)),summary.checklist.exceptions)
        refused(CloseProblem.REVIEW_REQUIRED)
        refused(CloseProblem.EXCEPTIONS_CHANGED,TripCloseRequest(closeId,"unprinted_receipts=2",null,null))
        val result = close.commit(TripCloseRequest(closeId,summary.checklist.reviewCode,1234.5," Back at depot "))
        assertTrue(result.reviewed); assertFalse(result.replay); assertEquals("Back at depot",result.note); assertEquals(1234.5,result.endOdometerKm!!,0.0)
        val row = db.rows().tripClose(s,d,summary.tripId)!!
        assertEquals(closeId,row.closeId); assertTrue(row.reviewed)
        val ops = db.rows().outboxRows(s,d)
        val op = ops.single { it.kind == TRIP_CLOSE_KIND }
        assertEquals(SALE_PARKED,op.status); assertEquals(row.idempotencyKey,op.clientRequestId)
        val payload = JSONObject(op.operationJson).getJSONObject("payload")
        assertEquals(summary.tripId,payload.getString("tripId")); assertEquals(closeId,payload.getString("closeId"))
        assertEquals("6850",payload.getJSONObject("cash").getString("declaredMinor")); assertEquals("0",payload.getJSONObject("cash").getString("varianceMinor"))
        assertEquals(0,payload.getJSONObject("stock").getInt("varianceLines"))
        assertEquals("unprinted_receipts",payload.getJSONArray("exceptions").getJSONObject(0).getString("kind"))
        assertTrue(payload.getBoolean("exceptionsReviewed"))
        // The manifest lists every other operation of the trip: the sale, the cash count and the stock count.
        val manifest = (0 until payload.getJSONArray("operations").length()).map { payload.getJSONArray("operations").getJSONObject(it).getString("kind") }
        assertEquals(listOf(SALE_KIND,CASH_RECONCILE_KIND,STOCK_RECONCILE_KIND),manifest); assertEquals(3,row.operationCount)
        assertTrue(store.tripClosed.first())
        assertNotNull(sale)
        Unit
    }

    @Test fun replayReturnsTheSavedCloseAndADifferentCloseIsRefused() = runBlocking {
        countCash(emptyMap(),0); countStock()
        val request = TripCloseRequest(closeId,null,null,null)
        close.commit(request); val before = snapshot()
        assertTrue(close.commit(request).replay); assertEquals(before,snapshot())
        refused(CloseProblem.ALREADY_CLOSED,TripCloseRequest(closeId,null,10.0,null))
        refused(CloseProblem.ALREADY_CLOSED,TripCloseRequest(UUID.randomUUID().toString(),null,null,null))
    }

    @Test fun waitingUploadsBlockAndAnOfficeRefusalBecomesAnExceptionToConfirm() = runBlocking {
        store.recordDamage(juice,1,"expired",null)
        countCash(emptyMap(),0); countStock()
        val waiting = close.summary()!!.checklist
        assertEquals(listOf(CloseStep.UPLOADS_SENT),waiting.blockers.map { it.step }); assertEquals(1,waiting.blockers.single().count)
        refused(CloseProblem.UPLOADS_WAITING)
        val damage = db.rows().outboxRows(s,d).single { it.kind == "truck.damage" }
        store.recordResult(damage,PushResult(damage.kind,damage.clientRequestId,"rejected",code = "invalid_request"))
        val summary = close.summary()!!
        assertTrue(summary.checklist.ready)
        assertEquals(listOf(CloseException(CloseExceptionKind.OFFICE_REFUSED,1)),summary.checklist.exceptions)
        assertTrue(close.commit(TripCloseRequest(closeId,summary.checklist.reviewCode,null,null)).reviewed); Unit
    }

    @Test fun cashDifferenceIsCarriedAsAnExceptionAndOdometerBelowStartIsRefused() = runBlocking {
        sell(); countCash(mapOf(5_000L to 1L),6850,"counting_error"); countStock()
        val summary = close.summary()!!
        assertEquals(listOf(CloseException(CloseExceptionKind.UNPRINTED_RECEIPTS,1),CloseException(CloseExceptionKind.CASH_DIFFERENCE,-1850)),summary.checklist.exceptions)
        refused(CloseProblem.ODOMETER_INVALID,TripCloseRequest(closeId,summary.checklist.reviewCode,-5.0,null))
        refused(CloseProblem.NOTE_INVALID,TripCloseRequest(closeId,summary.checklist.reviewCode,null,"x".repeat(301)))
        assertEquals(2,close.commit(TripCloseRequest(closeId,summary.checklist.reviewCode,null,null)).exceptions.size); Unit
    }

    @Test fun aClosedTripTakesNoMoreSalesVoidsReturnsDamageOrCounts() = runBlocking {
        val sale = sell(); countCash(cash6850,6850); countStock()
        val summary = close.summary()!!
        close.commit(TripCloseRequest(closeId,summary.checklist.reviewCode,null,null))
        val checkout = runCatching { sell() }.exceptionOrNull()
        assertTrue("$checkout",checkout is CheckoutRefused)
        val void = runCatching { store.voidSale(sale.saleId,"customer_cancelled",null,null) }.exceptionOrNull()
        assertTrue(void is VoidRefused && void.problem == VoidProblem.TRIP_CLOSED)
        assertFalse(ReturnStore(store).context().tripOpen)
        val damage = runCatching { store.recordDamage(juice,1,"expired",null) }.exceptionOrNull()
        assertTrue(damage is StockRefused && damage.problem == StockProblem.TRIP_CLOSED)
        assertFalse(store.canRemove(juice,1))
        assertFalse(CashReconciliationStore(store).summary()!!.countable); assertFalse(StockReconciliationStore(store).summary()!!.countable)
    }

    @Test fun heldPartitionRefusesAndLeavesTheDatabaseUnchanged() = runBlocking {
        countCash(emptyMap(),0); countStock(); store.hold()
        refused(CloseProblem.HELD)
    }
}
