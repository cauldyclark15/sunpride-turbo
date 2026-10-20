package com.sunpride.van.storage

import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.*
import com.sunpride.van.sync.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

class V2AuthorizationStoreTest {
    private val context=InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private val scope=StoreScope("v2|subject|fingerprint","device")
    private var now=1791338400010L
    private val at=1791338400000L
    private val product="k57prod0000000000000000000000001"
    private lateinit var store: RoomVanStore
    private val key="v2-sqlcipher-test-only".toByteArray()
    @Before fun setup() { name="van-v2-${UUID.randomUUID()}.db"; db=EncryptedVanDatabase.openWithPassphrase(context,key,name); store=RoomVanStore(db,scope,clock={now}) }
    @After fun close() { db.close(); context.deleteDatabase(name) }
    private fun snapshot(time: Long=at,available: Long=10): String {
        val o=JSONObject(FakeVanBackend.FIXTURE).put("serverTime",time)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
        o.getJSONObject("load").put("status","posted")
        val lines=o.getJSONObject("load").getJSONArray("lines")
        for (i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        o.put("truckStock",org.json.JSONArray().put(JSONObject().put("productId",product).put("availableBase",available.toString()).put("damagedBase","0")))
        o.put("_v2",JSONObject().put("subject",scope.fullAuthSubject).put("scopeFingerprint","fingerprint").put("epoch","epoch")
            .put("cursor","cursor-$time").put("leaseExpiresAt",at+1000).put("cacheExpiresAt",at+1000))
        return o.toString()
    }
    @Test fun everyV2BusinessCaptureQueuesAndReplaysWithFrozenMoneyAndAckBeforeDone()=runBlocking {
        store.replaceBootstrap(snapshot())
        val outlet="k57out00000000000000000000000001"
        val sale=store.commitSale(com.sunpride.van.pos.CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(com.sunpride.van.pos.CartLine(product,2)),com.sunpride.van.pos.PaymentInput("cash",13700)),13700)
        val second=store.commitSale(com.sunpride.van.pos.CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(com.sunpride.van.pos.CartLine(product,1)),com.sunpride.van.pos.PaymentInput("cash",6850)),6850)
        ReturnStore(store).commit(com.sunpride.van.pos.ReturnRequest(UUID.randomUUID().toString(),outlet,sale.saleId,listOf(com.sunpride.van.pos.ReturnLineInput(product,"PC",1,"wrong_item",com.sunpride.van.pos.ReturnDisposition.RESELLABLE)),null))
        val policy=store.policy.first()!!; val trip=db.rows().trip(scope.fullAuthSubject,scope.deviceId)!!.tripId
        val code=com.sunpride.van.pos.VoidApprovalCodes.code(policy.voidApproval!!.key!!,trip,second.receiptNumber,second.totalMinor,"wrong_items")
        store.voidSale(second.saleId,"wrong_items",null,code)
        val captured=store.pending(); assertEquals(listOf("sale.record","sale.record","return.record","sale.void"),captured.map { it.kind })
        captured.forEach { row ->
            val wire=V2VanCodec.operation(row)
            assertEquals(row.clientRequestId,wire.getString("clientOpId"))
            if (row.kind=="sale.record") assertTrue(wire.getJSONObject("payload").get("totalMinor") is String)
        }
        store.markSending(captured.map { it.clientRequestId })
        db.close(); db=EncryptedVanDatabase.openWithPassphrase(context,key,name); store=RoomVanStore(db,scope,clock={now})
        store.resetSending(); assertEquals(captured.map { it.operationJson },store.pending().map { it.operationJson })
        suspend fun acknowledge() {
            store.pending().forEach { row ->
                val result=PushResult(row.kind,row.clientRequestId,"accepted",PushAck(row.clientRequestId,null,at+20))
                store.recordResult(row,result); store.recordResult(row,result)
                assertNotNull(db.rows().ack(scope.fullAuthSubject,scope.deviceId,row.clientRequestId))
                assertEquals("done",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,row.clientRequestId)!!.status)
            }
        }
        acknowledge()
        CashReconciliationStore(store).commit(com.sunpride.van.pos.CashCountRequest(UUID.randomUUID().toString(),mapOf(10000L to 1L,2000L to 1L,1000L to 1L,500L to 1L,100L to 2L),null,null,null,13700))
        val stock=StockReconciliationStore(store)
        stock.commit(com.sunpride.van.pos.StockCountRequest(UUID.randomUUID().toString(),stock.summary()!!.lines.map { com.sunpride.van.pos.StockCountLine(it.productId,it.status,it.expectedBase,it.expectedBase) }))
        assertEquals(setOf("cash.reconcile","stock.reconcile"),store.pending().map { it.kind }.toSet()); acknowledge()
        val close=TripCloseStore(store); val summary=close.summary()!!
        close.commit(com.sunpride.van.pos.TripCloseRequest(UUID.randomUUID().toString(),summary.checklist.reviewCode,null,null))
        val row=store.pending().single(); assertEquals("trip.close",row.kind)
        val wire=V2VanCodec.operation(row); assertEquals(6,wire.getJSONObject("payload").getJSONArray("operations").length())
        acknowledge(); assertEquals(7,db.rows().ackRows(scope.fullAuthSubject,scope.deviceId).size)
        assertTrue(store.pending().isEmpty()); Unit
    }
    @Test fun refusedMovementIsRetainedButPhysicalCountUsesOfficeExpectedAndSupersedesItsProjection()=runBlocking {
        store.replaceBootstrap(snapshot())
        val id=store.recordDamage(product,1,"expired",null)
        val row=store.pending().single()
        store.recordResult(row,PushResult(row.kind,id,"rejected",code="invalid_request"))
        val count=StockReconciliationStore(store); val summary=count.summary()!!
        assertEquals(10L,summary.lines.single { it.productId==product && it.status=="available" }.expectedBase)
        val request=com.sunpride.van.pos.StockCountRequest(UUID.randomUUID().toString(),summary.lines.map { com.sunpride.van.pos.StockCountLine(it.productId,it.status,it.expectedBase,it.expectedBase) })
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_count BEFORE INSERT ON stock_reconciliation BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching { count.commit(request) }.isFailure)
        assertTrue(db.rows().movementsettlementRows(scope.fullAuthSubject,scope.deviceId).isEmpty())
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_count")
        count.commit(request)
        assertEquals("rejected",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status)
        assertEquals(row.operationJson,db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.operationJson)
        assertEquals(2,db.rows().stockmovementRows(scope.fullAuthSubject,scope.deviceId).size)
        assertEquals(10L,store.stock().single { it.productId==product }.availableBase)
        assertEquals(0L,store.stock().single { it.productId==product }.damagedBase)
        CashReconciliationStore(store).commit(com.sunpride.van.pos.CashCountRequest(UUID.randomUUID().toString(),emptyMap(),null,null,null,0))
        store.pending().forEach { pending -> store.recordResult(pending,PushResult(pending.kind,pending.clientRequestId,"accepted",PushAck(pending.clientRequestId,null,at+20))) }
        val close=TripCloseStore(store); val closing=close.summary()!!
        close.commit(com.sunpride.van.pos.TripCloseRequest(UUID.randomUUID().toString(),closing.checklist.reviewCode,null,null))
        val manifest=V2VanCodec.operation(store.pending().single()).getJSONObject("payload").getJSONArray("operations")
        assertEquals(2,manifest.length())
        assertTrue((0 until manifest.length()).none { manifest.getJSONObject(it).getString("clientRequestId")==id })
        assertEquals("rejected",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status); Unit
    }
    @Test fun delayedBootstrapCannotRenewAfterHoldEvenWhenSqlTeardownFails()=runBlocking {
        store.replaceBootstrap(snapshot())
        val before=store.authorizationEpoch()
        val gateway=object: VanGateway {
            override suspend fun bootstrap(): String {
                db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_hold BEFORE INSERT ON sync_meta BEGIN SELECT RAISE(ABORT,'injected'); END")
                assertTrue(runCatching { store.hold() }.isFailure)
                db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_hold")
                return snapshot(at+30,8)
            }
            override suspend fun push(operations: List<OutboxRow>): List<PushResult> = error("must not send")
        }
        assertTrue(runCatching { VanSync(store,gateway).syncNow() }.isFailure)
        assertTrue(store.authorizationEpoch() > before)
        assertTrue(db.rows().meta(scope.fullAuthSubject,scope.deviceId)!!.held)
        assertEquals(10L,store.stock().first { it.productId==product }.availableBase); Unit
    }
    @Test fun grantAndCursorCommitWithBaselineAndExpireForEveryNewWrite()=runBlocking {
        store.replaceBootstrap(snapshot()); assertTrue(store.canSync())
        val meta=db.rows().meta(scope.fullAuthSubject,scope.deviceId)!!
        assertEquals("fingerprint",meta.scopeFingerprint); assertEquals("epoch",meta.authorizationEpoch); assertEquals("cursor-$at",meta.cursor)
        now=at+1001
        assertFalse(store.canSync()); assertFalse(store.canRemove(product,1))
        assertTrue(runCatching { store.recordDamage(product,1,"expired",null) }.isFailure)
        assertTrue(db.rows().outboxRows(scope.fullAuthSubject,scope.deviceId).isEmpty()); Unit
    }
    @Test fun missingGrantCannotAdoptLegacySnapshotOrUnholdEvidence()=runBlocking {
        assertTrue(runCatching { store.replaceBootstrap(FakeVanBackend.FIXTURE) }.isFailure)
        assertNull(db.rows().meta(scope.fullAuthSubject,scope.deviceId))
        store.replaceBootstrap(snapshot()); val id=store.recordDamage(product,1,"expired",null); store.hold()
        assertTrue(runCatching { store.replaceBootstrap(FakeVanBackend.FIXTURE) }.isFailure)
        assertTrue(db.rows().meta(scope.fullAuthSubject,scope.deviceId)!!.held)
        assertEquals(id,db.rows().outboxRows(scope.fullAuthSubject,scope.deviceId).single().clientRequestId); Unit
    }
    @Test fun baselineAndGrantRollbackTogetherAndOtherScopesStayHeld()=runBlocking {
        db.rows().insertSyncMeta(SyncMetaRow("legacy|subject","device",held=false))
        store.replaceBootstrap(snapshot()); assertTrue(db.rows().meta("legacy|subject","device")!!.held)
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_v2_meta BEFORE INSERT ON sync_meta BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching { store.replaceBootstrap(snapshot(at+1,8)) }.isFailure)
        assertEquals("cursor-$at",db.rows().meta(scope.fullAuthSubject,scope.deviceId)!!.cursor)
        assertEquals(10L,store.stock().first { it.productId==product }.availableBase); Unit
    }
    @Test fun lostReplyReplayKeepsUuidAckAndSingleDeductionAcrossReopen()=runBlocking {
        store.replaceBootstrap(snapshot()); val id=store.recordDamage(product,1,"expired",null)
        val row=store.pending().single(); store.markSending(listOf(id))
        db.close(); db=EncryptedVanDatabase.openWithPassphrase(context,key,name); store=RoomVanStore(db,scope,clock={now})
        store.resetSending(); assertEquals(row.operationJson,store.pending().single().operationJson)
        val result=PushResult(row.kind,id,"accepted",PushAck("damage","movement",at+20))
        store.recordResult(row,result); store.recordResult(row,result)
        val o=JSONObject(snapshot(at+30,9)); o.getJSONArray("truckStock").getJSONObject(0).put("damagedBase","1")
        store.replaceBootstrap(o.toString())
        assertEquals(9L,store.stock().first { it.productId==product }.availableBase)
        assertEquals(1,db.rows().ackRows(scope.fullAuthSubject,scope.deviceId).size)
        assertEquals("done",db.rows().outbox(scope.fullAuthSubject,scope.deviceId,id)!!.status); Unit
    }
}
