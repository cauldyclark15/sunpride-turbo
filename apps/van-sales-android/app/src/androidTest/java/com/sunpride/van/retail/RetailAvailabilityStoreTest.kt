package com.sunpride.van.retail

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sunpride.retail.ShelfAnswer
import com.sunpride.van.data.PushAck
import com.sunpride.van.data.PushResult
import com.sunpride.van.storage.RoomVanStore
import com.sunpride.van.sync.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.io.IOException
import java.util.UUID

/** F-212/F-213: actual v2 queued SQLCipher Room writes, not the legacy parked-sale path. */
@RunWith(AndroidJUnit4::class)
class RetailAvailabilityStoreTest {
    private lateinit var f: RetailRoomFixture
    private val s get()=f.scope.fullAuthSubject
    private val d get()=f.scope.deviceId
    @Before fun open() { f=RetailRoomFixture(); f.ready() }
    @After fun close() { f.close() }
    private suspend fun noSale() {
        assertTrue(f.db.rows().saleRows(s,d).isEmpty()); assertTrue(f.db.rows().salelineRows(s,d).isEmpty())
        assertTrue(f.db.rows().paymentRows(s,d).isEmpty()); assertTrue(f.db.rows().stockmovementRows(s,d).isEmpty())
        assertTrue(f.db.rows().transactionidRows(s,d).isEmpty()); assertTrue(f.db.rows().sequencecounterRows(s,d).isEmpty())
        assertEquals(20L,f.store.stock().single { it.productId==f.product }.availableBase)
    }
    @Test fun F212_incompleteAvailabilityCannotCreateCheckoutOrPartialQueue() = runBlocking {
        val request=f.request()
        assertEquals("Check every MSL line before checkout",runCatching { f.store.commitSale(request,5000) }.exceptionOrNull()?.message)
        assertTrue(runCatching { f.store.saveRetail(f.call,request.saleId,
            listOf(ShelfAnswer(f.product,"absent",shelfBase=0)),mapOf(f.product to 3L)) }.exceptionOrNull() is IllegalArgumentException)
        assertFalse(f.store.retailSaved(request.saleId)); assertTrue(f.store.pending().isEmpty()); noSale()
        Unit
    }
    @Test fun F213_completeAbsentCheckAndAcceptanceAreDurableAndUnlockOnlyTheirOwnCheckout() = runBlocking {
        val request=f.request()
        f.store.saveRetail(f.call,request.saleId,f.answers(),mapOf(f.product to 5L,f.second to 0L))
        val queued=f.store.pending()
        assertEquals(listOf("availability.record","availability.proposal"),queued.map { it.kind })
        assertTrue(queued.all { it.status=="pending" }); assertTrue(queued[0].createdAt<queued[1].createdAt)
        val check=JSONObject(queued[0].operationJson).getJSONObject("payload")
        val proposalOp=JSONObject(queued[1].operationJson); val decision=proposalOp.getJSONObject("payload")
        assertTrue(check.getBoolean("complete")); assertEquals(f.call.snapshotId,check.getString("snapshotId"))
        assertEquals(request.saleId,check.getString("callKey")); assertEquals(2,check.getJSONArray("lines").length())
        assertEquals("accepted",decision.getString("decision")); assertEquals(5L,decision.getLong("quantityBase"))
        assertEquals(request.saleId,decision.getString("orderKey")); assertEquals(check.getString("checkId"),decision.getString("checkId"))
        assertEquals(queued[0].clientRequestId,proposalOp.getJSONArray("dependsOn").getString(0))
        noSale() // preparing an editable order is not a sale, receipt, payment or stock deduction
        f.reopen()
        assertEquals(queued,f.store.pending()); assertEquals(f.call,f.store.retailCall(f.outlet))
        assertTrue(f.store.retailSaved(request.saleId))
        assertEquals("Check every MSL line before checkout",runCatching {
            f.store.commitSale(request.copy(saleId=UUID.randomUUID().toString()),5000) }.exceptionOrNull()?.message)
        val receipt=f.store.commitSale(request,5000)
        assertEquals(5000L,receipt.totalMinor); assertEquals(15L,f.store.stock().single { it.productId==f.product }.availableBase)
        assertTrue(f.store.commitSale(request,5000).replay)
        assertEquals(1,f.db.rows().saleRows(s,d).size); assertEquals(1,f.db.rows().stockmovementRows(s,d).size)
        assertEquals(3,f.store.pending().size)
        Unit
    }
    @Test fun F213_negativeOrForeignProposalsRefuseWithoutPartialQueue() = runBlocking {
        for(quantities in listOf(mapOf(f.product to -1L),mapOf(f.product to 1_000_000_001L),mapOf("foreign" to 1L))) {
            val callKey=UUID.randomUUID().toString()
            assertTrue(runCatching { f.store.saveRetail(f.call,callKey,f.answers(),quantities) }.exceptionOrNull() is IllegalArgumentException)
            assertFalse(f.store.retailSaved(callKey)); assertTrue(f.store.pending().isEmpty()); noSale()
        }
        Unit
    }
    @Test fun F213_proposalFailureRollsBackWholeCheckAndRetryDoesNotDuplicateIt() = runBlocking {
        val callKey=UUID.randomUUID().toString()
        f.db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_retail BEFORE INSERT ON outbox WHEN NEW.kind='availability.proposal' BEGIN SELECT RAISE(ABORT,'retail test failure'); END")
        assertNotNull(runCatching { f.store.saveRetail(f.call,callKey,f.answers(),mapOf(f.product to 5L)) }.exceptionOrNull())
        assertFalse(f.store.retailSaved(callKey)); assertTrue(f.store.pending().isEmpty()); noSale()
        f.db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_retail")
        f.store.saveRetail(f.call,callKey,f.answers(),mapOf(f.product to 5L))
        val original=f.store.pending()
        assertEquals("Availability already saved",runCatching {
            f.store.saveRetail(f.call,callKey,f.answers(),mapOf(f.product to 7L)) }.exceptionOrNull()?.message)
        assertEquals(original,f.store.pending()); noSale()
        Unit
    }
    @Test fun F213_zeroDismissalAndRejectedChecksDoNotMasqueradeAsAcceptedOrders() = runBlocking {
        val key=UUID.randomUUID().toString()
        f.store.saveRetail(f.call,key,f.answers(),mapOf(f.product to 0L,f.second to 0L))
        val rows=f.store.pending(); val p=JSONObject(rows.last().operationJson).getJSONObject("payload")
        assertEquals("dismissed",p.getString("decision")); assertEquals(0L,p.getLong("quantityBase")); assertTrue(p.isNull("orderKey"))
        noSale()
        f.store.recordResult(rows[0],PushResult(rows[0].kind,rows[0].clientRequestId,"rejected",code="invalid_request"))
        assertFalse(f.store.retailSaved(key))
        assertEquals("Check every MSL line before checkout",runCatching { f.store.commitSale(f.request(key),5000) }.exceptionOrNull()?.message)
        val foreign=RoomVanStore(f.db,f.scope.copy(fullAuthSubject="v2|other|scope"),clock={f.at+10})
        assertNull(foreign.retailCall(f.outlet)); assertFalse(foreign.retailSaved(key)); assertTrue(foreign.pending().isEmpty())
        Unit
    }
    @Test fun F212_F213_lostReplyReplaysImmutableCheckAndProposalWithOneAckEach() = runBlocking {
        val key=UUID.randomUUID().toString()
        f.store.saveRetail(f.call,key,f.answers(),mapOf(f.product to 5L,f.second to 0L))
        val captured=f.store.pending()
        val attempts=mutableListOf<List<String>>()
        var lose=true
        val accepted=mutableMapOf<String,PushResult>()
        val gateway=object : VanGateway {
            override suspend fun bootstrap()=f.snapshot()
            override suspend fun push(operations: List<com.sunpride.van.storage.OutboxRow>): List<PushResult> {
                attempts+=operations.map { V2VanCodec.operation(it).toString() }
                val results=operations.map { row -> accepted.getOrPut(row.clientRequestId) {
                    PushResult(row.kind,row.clientRequestId,"accepted",PushAck("entity-${row.clientRequestId}",null,f.at+20)) } }
                if(lose) { lose=false; throw IOException("Reply lost after acceptance") }
                return results
            }
        }
        assertNotNull(runCatching { VanSync(f.store,gateway).syncNow() }.exceptionOrNull())
        assertEquals(captured.map { it.operationJson },f.store.pending().map { it.operationJson })
        assertTrue(f.db.rows().ackRows(s,d).isEmpty())
        f.reopen(); VanSync(f.store,gateway).syncNow()
        assertEquals(2,attempts.size); assertEquals(attempts[0],attempts[1])
        assertEquals(2,accepted.size); assertEquals(2,f.db.rows().ackRows(s,d).size)
        assertTrue(f.store.pending().isEmpty()); assertTrue(f.store.retailSaved(key))
        captured.forEach { row ->
            val result=accepted.getValue(row.clientRequestId)
            f.store.recordResult(row,result); f.store.recordResult(row,result)
            assertEquals("done",f.db.rows().outbox(s,d,row.clientRequestId)!!.status)
            assertEquals(row.operationJson,f.db.rows().outbox(s,d,row.clientRequestId)!!.operationJson)
        }
        assertEquals(2,f.db.rows().outboxRows(s,d).size); noSale()
        Unit
    }
}
