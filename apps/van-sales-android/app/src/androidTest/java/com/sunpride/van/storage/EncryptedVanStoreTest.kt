package com.sunpride.van.storage

import androidx.room.withTransaction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.*
import com.sunpride.van.ids.TransactionIds
import com.sunpride.van.sync.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.json.JSONArray
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class EncryptedVanStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private val key = "test-only-sqlcipher-key-not-a-production-secret".toByteArray()
    private val scope = StoreScope("https://test.invalid|full-subject","device-one")
    private lateinit var store: RoomVanStore
    private val at = 1791338400000L
    private val product = "k57prod0000000000000000000000001"
    @Before fun setup() {
        name = "van-encrypted-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,key,name)
        store = RoomVanStore(db,scope,clock={ at+10 })
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }
    private fun fixture(active: Boolean = true, available: Long = 10, serverTime: Long = at): String {
        val o = JSONObject(FakeVanBackend.FIXTURE).put("serverTime",serverTime)
        if(active) {
            o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
            o.getJSONObject("load").put("status","posted")
            val lines = o.getJSONObject("load").getJSONArray("lines")
            for(i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        }
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",product).put("availableBase",available.toString()).put("damagedBase","0")))
        return o.toString()
    }
    @Test fun databaseAndWalHaveNoPlaintextAndWrongKeyFails() = runBlocking {
        store.replaceBootstrap(fixture())
        val marker = "VAN-PLAINTEXT-MARKER-9fe372"
        store.addWalkInCustomer(marker,"test-only reason")
        val paths = listOf(context.getDatabasePath(name),java.io.File(context.getDatabasePath(name).path+"-wal"))
        paths.filter { it.exists() }.forEach { assertFalse(String(it.readBytes(),Charsets.ISO_8859_1).contains(marker)) }
        db.close()
        val failure = runCatching { EncryptedVanDatabase.openWithPassphrase(context,"wrong-key".toByteArray(),name).close() }.exceptionOrNull()
        assertNotNull(failure)
        db = EncryptedVanDatabase.openWithPassphrase(context,key,name)
        assertTrue(RoomVanStore(db,scope).customers.first().any { it.name==marker }); Unit
    }
    @Test fun fiftyConcurrentIdentifiersAreDistinctAndCounterSurvivesReopen() = runBlocking {
        val ids = TransactionIds(db,scope)
        val pairs = (1..50).map { async(Dispatchers.Default) { ids.issue("trip","TRIP-20261007-V014-1") } }.awaitAll()
        assertEquals(50,pairs.map { it.receiptNumber }.toSet().size); assertEquals(50,pairs.map { it.idempotencyKey }.toSet().size)
        assertTrue(pairs.all { UUID.fromString(it.idempotencyKey).version()==4 })
        db.close(); db = EncryptedVanDatabase.openWithPassphrase(context,key,name)
        assertTrue(TransactionIds(db,scope).issue("trip","TRIP-20261007-V014-1").receiptNumber.endsWith("0051")); Unit
    }
    @Test fun damageAndOutboxInsertAreAtomicWhenSecondLedgerInsertFails() = runBlocking {
        store.replaceBootstrap(fixture())
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_damage BEFORE INSERT ON stock_movement WHEN NEW.stockStatus='damaged' BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching { store.recordDamage(product,3,"crushed",null) }.isFailure)
        assertTrue(db.rows().outboxRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
        assertTrue(db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
        assertEquals(10L,store.stock().single().availableBase); Unit
    }
    @Test fun negativeStockRefusesUnlessPolicyExplicitlyAllowsIt() = runBlocking {
        store.replaceBootstrap(fixture())
        assertFalse(store.canRemove(product,11)); assertTrue(runCatching { store.recordDamage(product,11,"crushed",null) }.isFailure)
        val o=JSONObject(fixture()).put("serverTime",at+1); o.getJSONObject("policy").put("allowNegativeStock",true)
        store.replaceBootstrap(o.toString()); assertTrue(store.canRemove(product,11)); store.recordDamage(product,11,"crushed",null)
        assertEquals(-1L,store.stock().single().availableBase); assertEquals(11L,store.stock().single().damagedBase); Unit
    }
    @Test fun acknowledgementIsDurableBeforeDoneAndSettlementRetainsLedger() = runBlocking {
        store.replaceBootstrap(fixture()); val id=store.recordDamage(product,3,"crushed",null)
        val row=store.pending().single(); store.markSending(listOf(id))
        db.rows().markDone(scope.fullAuthSubject,scope.deviceId,id)
        assertEquals("sending",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status)
        val result=PushResult(row.kind,id,"accepted",PushAck("trip","movement",at+20))
        store.recordResult(row,result)
        assertNotNull(db.rows().ack(scope.fullAuthSubject,scope.deviceId,id)); assertEquals("done",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status)
        assertEquals(7L,store.stock().single().availableBase)
        val o=JSONObject(fixture(available=7,serverTime=at+21)); o.getJSONArray("truckStock").getJSONObject(0).put("damagedBase","3")
        store.replaceBootstrap(o.toString()); store.recordResult(row,result)
        assertEquals(7L,store.stock().single().availableBase); assertEquals(3L,store.stock().single().damagedBase)
        assertEquals(2,db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).size); assertEquals(2,db.rows().movementsettlementRows(scope.fullAuthSubject,scope.deviceId).size); Unit
    }
    @Test fun pendingLoadDoesNotBecomeStockUntilServerPostingAck() = runBlocking {
        store.replaceBootstrap(fixture(active=false,available=0))
        val id=store.confirmLoad(listOf(LoadActual(1,48),LoadActual(2,24)))
        assertTrue(store.load.first()!!.confirmPending); assertEquals(48L,store.load.first()!!.lines.first().pendingActualBase)
        assertTrue(db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
        val row=store.pending().single(); store.recordResult(row,PushResult(row.kind,id,"accepted",PushAck("load","server-load-movement",at+20)))
        assertEquals(48L,store.stock().first { it.productId==product }.availableBase)
        val o=JSONObject(fixture(active=true,available=48,serverTime=at+21)); store.replaceBootstrap(o.toString())
        assertEquals(48L,store.stock().first { it.productId==product }.availableBase)
        assertEquals(2,db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).size); Unit
    }
    @Test fun discrepancyAckHasNoLoadMovementUntilLaterPostedBootstrap() = runBlocking {
        store.replaceBootstrap(fixture(active=false,available=0))
        val id=store.confirmLoad(listOf(LoadActual(1,47,"short_loaded"),LoadActual(2,24)))
        val row=store.pending().single(); store.recordResult(row,PushResult(row.kind,id,"accepted",PushAck("load",null,at+20)))
        assertTrue(db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
        val o=JSONObject(fixture(available=47,serverTime=at+21)); o.getJSONObject("load").getJSONArray("lines").getJSONObject(0).put("actualBase","47").put("discrepancyReason","short_loaded")
        store.replaceBootstrap(o.toString())
        assertEquals(47L,store.stock().first { it.productId==product }.availableBase)
        assertEquals(2,db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).size); Unit
    }
    @Test fun bootstrapPreservesOutboxSalesWalkInsAndScopes() = runBlocking {
        store.replaceBootstrap(fixture()); val id=store.recordDamage(product,1,"crushed",null); store.addWalkInCustomer("Walk in","cash buyer")
        db.rows().insertSale(SaleRow(scope.fullAuthSubject,scope.deviceId,"sale","trip","receipt","key","customer","saved",createdAt=1))
        val before=db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.operationJson
        store.replaceBootstrap(fixture(serverTime=at+1))
        assertEquals(before,db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.operationJson); assertEquals(1,db.rows().saleRows(scope.fullAuthSubject,scope.deviceId).size)
        assertTrue(store.customers.first().any { it.localOnly && it.source=="walk_in" && it.reason=="cash buyer" })
        assertTrue(RoomVanStore(db,StoreScope("other-issuer|full-subject",scope.deviceId)).customers.first().isEmpty())
        assertTrue(RoomVanStore(db,StoreScope(scope.fullAuthSubject,"other-device")).stock().isEmpty()); Unit
    }
    @Test fun processRestartResetsPersistedSendingWithoutChangingOperationBytes() = runBlocking {
        store.replaceBootstrap(fixture()); val id=store.recordDamage(product,1,"crushed",null)
        val original=store.pending().single().operationJson; store.markSending(listOf(id))
        db.close(); db=EncryptedVanDatabase.openWithPassphrase(context,key,name); store=RoomVanStore(db,scope)
        assertEquals("sending",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status)
        store.resetSending(); val recovered=store.pending().single()
        assertEquals(id,recovered.clientRequestId); assertEquals(original,recovered.operationJson); Unit
    }
    @Test fun localSaleRefusesNegativeAndMovementReplayCannotDoubleDeduct() = runBlocking {
        store.replaceBootstrap(fixture())
        val ledger=com.sunpride.van.ledger.TruckStockLedger(store); val id=UUID.randomUUID().toString()
        assertTrue(runCatching { ledger.recordLocalMovement(com.sunpride.van.ledger.MovementType.SALE,product,com.sunpride.van.ledger.StockStatus.available,-11,null,id) }.isFailure)
        ledger.recordLocalMovement(com.sunpride.van.ledger.MovementType.SALE,product,com.sunpride.van.ledger.StockStatus.available,-3,null,id)
        ledger.recordLocalMovement(com.sunpride.van.ledger.MovementType.SALE,product,com.sunpride.van.ledger.StockStatus.available,-3,null,id)
        assertEquals(7L,store.stock().single().availableBase); assertEquals(1,db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).size); Unit
    }
    @Test fun holdAndReviewNeverAutomaticallyRetry() = runBlocking {
        store.replaceBootstrap(fixture()); val id=store.recordDamage(product,1,"crushed",null); val row=store.pending().single()
        store.recordResult(row,PushResult(row.kind,id,"conflict",code="conflict")); store.resetSending(); assertTrue(store.pending().isEmpty())
        store.hold(); assertTrue(runCatching { store.recordDamage(product,1,"crushed",null) }.isFailure)
        store.replaceBootstrap(fixture(serverTime=at+1)); assertTrue(store.pending().isEmpty()); assertEquals("conflict",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status); Unit
    }
    @Test fun sqlcipherOutboxReplaysAfterUncertainServerAcceptance() = runBlocking {
        val backend=FakeVanBackend(); store.replaceBootstrap(backend.bootstrap())
        store.confirmLoad(listOf(LoadActual(1,48),LoadActual(2,24))); VanSync(store,backend).syncNow()
        store.startTrip(true,true,null,null,null,null); VanSync(store,backend).syncNow()
        val id=store.recordDamage(product,2,"crushed",null); val original=store.pending().single().operationJson
        var fail=true
        val uncertain=object : VanGateway {
            override suspend fun bootstrap()=backend.bootstrap()
            override suspend fun push(operations: List<OutboxRow>): List<PushResult> { val r=backend.push(operations); if(fail) { fail=false; throw VanSyncFailure("offline",true) }; return r }
        }
        assertTrue(runCatching { VanSync(store,uncertain).syncNow() }.isFailure)
        assertEquals(original,store.pending().single().operationJson); assertEquals(id,store.pending().single().clientRequestId)
        VanSync(store,uncertain).syncNow(); assertEquals(46L,store.stock().first { it.productId==product }.availableBase)
        assertEquals(2L,store.stock().first { it.productId==product }.damagedBase); assertTrue(store.pending().isEmpty()); Unit
    }
}
