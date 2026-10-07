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

/** VAN-023 against the real encrypted Room store: atomic rows, movements, parked op and freeze guards. */
@RunWith(AndroidJUnit4::class)
class StockReconciliationStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private lateinit var store: RoomVanStore
    private lateinit var stock: StockReconciliationStore
    private val scope = StoreScope("https://test.invalid|stock-seller","stock-device")
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val chunks = "k57prod0000000000000000000000002"
    private val outlet = "k57out00000000000000000000000001"

    @Before fun setup() = runBlocking {
        name = "van-stock-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,"test-only-stock-sqlcipher-key".toByteArray(),name)
        store = RoomVanStore(db,scope,clock = { at + 10 })
        stock = StockReconciliationStore(store)
        val o = JSONObject(FakeVanBackend.FIXTURE)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
        o.getJSONObject("load").put("status","posted")
        val load = o.getJSONObject("load").getJSONArray("lines")
        for (i in 0 until load.length()) load.getJSONObject(i).put("actualBase",load.getJSONObject(i).getString("expectedBase"))
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase","20").put("damagedBase","0"))
            .put(JSONObject().put("productId",chunks).put("availableBase","20").put("damagedBase","0")))
        store.replaceBootstrap(o.toString()); Unit
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }

    private suspend fun screenLines() = stock.summary()!!.lines.map { it to it.expectedBase }
    private fun request(lines: List<StockCountLine>, id: String = UUID.randomUUID().toString(), note: String? = null, code: String? = null) = StockCountRequest(id,lines,note,code)
    private suspend fun approvedRequest(lines: List<StockCountLine>, id: String = UUID.randomUUID().toString()) : StockCountRequest {
        val totals = StockReconciliationRules.summary(lines); val countCode = StockReconciliationRules.countCode(db.rows().trip(s,d)!!.tripId,id,lines)
        val key = store.policy.first()!!.stockReconciliation!!.key!!
        return request(lines,id,code = StockApprovalCodes.code(key,db.rows().trip(s,d)!!.tripId,countCode,totals.varianceLines,totals.shortBase,totals.overBase))
    }
    private suspend fun refused(expected: StockProblem, block: suspend () -> Unit) {
        val failure = runCatching { block() }.exceptionOrNull()
        assertTrue("Expected StockRefused, got $failure",failure is StockRefused); assertEquals(expected,(failure as StockRefused).problem)
    }
    private fun snapshot(): Map<String,List<List<String?>>> {
        val sql = db.openHelper.writableDatabase
        val tables = sql.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
        return tables.associateWith { table -> sql.query("SELECT * FROM `$table` ORDER BY rowid").use { c -> buildList { while(c.moveToNext()) add((0 until c.columnCount).map { if(c.isNull(it)) null else c.getString(it) }) } } }
    }

    @Test fun commitWritesExactAdjustmentsAndParkedOperationAndProjectionBecomesTheCount() = runBlocking {
        val summary = stock.summary()!!; assertTrue(summary.countable); assertEquals(4,summary.lines.size)
        val lines = summary.lines.map { line -> when {
            line.productId == juice && line.status == StockCountLine.AVAILABLE -> StockCountLine(line.productId,line.status,line.expectedBase,18,"missing")
            line.productId == juice && line.status == StockCountLine.DAMAGED -> StockCountLine(line.productId,line.status,line.expectedBase,1,"damaged_not_recorded")
            else -> StockCountLine(line.productId,line.status,line.expectedBase,line.expectedBase)
        } }
        val result = stock.commit(approvedRequest(lines,"6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f"))
        assertTrue(result.approved); assertEquals(2,result.varianceLines); assertEquals(2L,result.shortBase); assertEquals(1L,result.overBase)
        val row = db.rows().stockReconciliation(s,d,summary.tripId)!!
        assertEquals(result.countCode,row.countCode); assertEquals("supervisor_code",row.approvalMethod)
        val movements = db.rows().stockmovementRows(s,d).filter { it.type == "ADJUSTMENT" }
        assertEquals(2,movements.size)
        assertEquals(setOf("${result.reconciliationId}:$juice:available:ADJUSTMENT","${result.reconciliationId}:$juice:damaged:ADJUSTMENT"),movements.map { it.movementId }.toSet())
        assertEquals(setOf(-2L,1L),movements.map { it.quantityBase }.toSet()); assertTrue(movements.all { it.clientRequestId == row.idempotencyKey })
        val op = db.rows().outboxRows(s,d).single { it.kind == STOCK_RECONCILE_KIND }
        assertEquals(SALE_PARKED,op.status); assertEquals(row.idempotencyKey,op.clientRequestId)
        val payload = JSONObject(op.operationJson).getJSONObject("payload")
        assertEquals(result.countCode,payload.getString("countCode")); assertEquals(2,payload.getInt("varianceLines")); assertEquals("2",payload.getString("shortBase")); assertEquals("1",payload.getString("overBase"))
        assertEquals(4,payload.getJSONArray("lines").length()); assertEquals("supervisor_code",payload.getJSONObject("approval").getString("method"))
        val now = store.stock(); assertEquals(18L,now.single { it.productId == juice }.availableBase); assertEquals(1L,now.single { it.productId == juice }.damagedBase)
        assertTrue(store.stockCounted.first()); Unit
    }

    @Test fun replayIsIdempotentDifferentContentIsRefusedAndEveryRefusalWritesNothing() = runBlocking {
        val lines = screenLines().map { (line,expected) -> StockCountLine(line.productId,line.status,expected,expected) }
        val id = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f"; val req = request(lines,id); val first = stock.commit(req); val before = snapshot()
        assertTrue(stock.commit(req).replay); assertEquals(before,snapshot())
        refused(StockProblem.ALREADY_COUNTED) { stock.commit(request(lines.map { if (it.status == StockCountLine.AVAILABLE) it.copy(countedBase = 1,reasonCode = "missing") else it },id)) }
        assertEquals(before,snapshot()); Unit
    }

    @Test fun expectedChangedAfterASaleIsRefusedBeforeAnyCountFactsAreWritten() = runBlocking {
        val screen = stock.summary()!!; val lines = screen.lines.map { StockCountLine(it.productId,it.status,it.expectedBase,it.expectedBase) }; val before = snapshot()
        store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(juice,1)),PaymentInput("cash",6850)),6850)
        val afterSale = snapshot(); refused(StockProblem.EXPECTED_CHANGED) { stock.commit(request(lines)) }
        assertEquals(afterSale,snapshot()); assertNull(db.rows().stockReconciliation(s,d,screen.tripId)); assertTrue(afterSale != before); Unit
    }

    @Test fun stockCountFreezesSalesVoidReturnsDamageAndAdjustments() = runBlocking {
        val sale = store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(juice,1)),PaymentInput("cash",6850)),6850)
        val lines = stock.summary()!!.lines.map { StockCountLine(it.productId,it.status,it.expectedBase,it.expectedBase) }
        stock.commit(request(lines))
        val checkout = runCatching { store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(juice,1)),PaymentInput("cash",6850)),6850) }.exceptionOrNull()
        assertTrue(checkout is CheckoutRefused && checkout.issues.any { it.problem == CheckoutProblem.STOCK_COUNTED })
        refused2(VoidProblem.STOCK_COUNTED) { store.voidSale(sale.saleId,"customer_cancelled",null,null) }
        val returnContext = ReturnStore(store).context()
        assertTrue(returnContext.stockCounted); assertFalse(returnContext.tripOpen)
        refused(StockProblem.STOCK_COUNTED) { store.recordDamage(juice,1,"crushed",null) }
        refused(StockProblem.STOCK_COUNTED) { store.recordLocalMovement(com.sunpride.van.ledger.MovementType.RETURN,juice,com.sunpride.van.ledger.StockStatus.available,1, "customer_return",UUID.randomUUID().toString()) }
    }
    private suspend fun refused2(expected: VoidProblem, block: suspend () -> Unit) {
        val failure = runCatching { block() }.exceptionOrNull(); assertTrue("Expected VoidRefused, got $failure",failure is VoidRefused); assertEquals(expected,(failure as VoidRefused).problem)
    }

    @Test fun heldPartitionRefusesAndLeavesTheDatabaseUnchanged() = runBlocking {
        store.hold(); val before = snapshot(); val lines = screenLines().map { (line,expected) -> StockCountLine(line.productId,line.status,expected,expected) }
        refused(StockProblem.HELD) { stock.commit(request(lines)) }; assertEquals(before,snapshot())
    }
}