package com.sunpride.field.retail

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sunpride.field.storage.*
import com.sunpride.field.sync.*
import com.sunpride.retail.ShelfAnswer
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith

/** Real encrypted Room + LiveFieldBackend; only auth, scheduler and HTTP boundaries are isolated. */
@RunWith(AndroidJUnit4::class)
class RetailAvailabilityStoreTest {
    private lateinit var f: RetailRoomFixture
    @Before fun open() { f=RetailRoomFixture(); f.ready() }
    @After fun close() { f.close() }

    @Test fun F212_incompleteAvailabilityRefusesCheckoutAndWritesNothing() = runBlocking {
        val before=f.store.history()
        val incomplete=runCatching { f.backend.saveRetail(f.call,f.start.clientVisitId,f.start.requestId,f.start.requestId,
            listOf(ShelfAnswer("p-absent","absent",shelfBase=0)),mapOf("p-absent" to 3L)) }.exceptionOrNull()
        assertTrue(incomplete is IllegalArgumentException)
        val end=runCatching { f.store.enqueue(f.checkout(),f.at+100) }.exceptionOrNull()
        assertEquals("Check every MSL line before ending the call",end?.message)
        assertEquals(before,f.store.history()); assertTrue(f.store.orderDrafts().isEmpty())
        Unit
    }
    @Test fun F213_completeAbsentCheckAndAcceptancePersistWithAnEditableUnsentOrder() = runBlocking {
        val draft=requireNotNull(f.save())
        val rows=f.store.history()
        assertEquals(listOf("visit.checkIn","availability.record","availability.proposal"),rows.map { it.first.kind })
        assertEquals(listOf("pending","pending","pending"),rows.map { it.second.state })
        assertTrue(rows.zipWithNext().all { (a,b)->a.first.createdAt<b.first.createdAt })
        val check=JSONObject(rows[1].first.serializedOperation)
        val record=check.getJSONObject("payload")
        assertTrue(record.getBoolean("complete")); assertEquals(f.call.snapshotId,record.getString("snapshotId"))
        assertEquals(f.start.clientVisitId,record.getString("callKey"))
        assertEquals("@checkin:${f.start.requestId}",record.getString("visitId"))
        assertEquals(2,record.getJSONArray("lines").length())
        assertEquals(2L,record.getJSONArray("lines").getJSONObject(0).getLong("backroomBase"))
        val proposal=JSONObject(rows[2].first.serializedOperation)
        val decision=proposal.getJSONObject("payload")
        assertEquals(record.getString("checkId"),decision.getString("checkId"))
        assertEquals("accepted",decision.getString("decision")); assertEquals(5L,decision.getLong("quantityBase"))
        assertEquals(draft.draftId,decision.getString("orderKey"))
        assertEquals(rows[1].first.requestId,proposal.getJSONArray("dependsOn").getString(0))
        assertEquals(5,draft.lines.single().quantity); assertEquals("p-absent",draft.lines.single().productId)
        assertNull(draft.submittedRequestId)
        f.reopen()
        assertEquals(rows,f.store.history()); assertEquals(draft,f.store.orderDrafts().single())
        assertEquals(f.call,f.backend.retailCall("outlet-retail"))
        val edited=f.backend.saveOrderDraft(draft.draftId,f.start.clientVisitId,f.start.requestId,listOf("p-absent" to 7))
        assertEquals(draft.draftId,edited.draftId); assertEquals(7,edited.lines.single().quantity)
        assertNull(edited.submittedRequestId); assertEquals(rows,f.store.history()) // editing never submits
        f.reopen(); assertEquals(7,f.store.orderDrafts().single().lines.single().quantity)
        f.store.enqueue(f.checkout(rows.last().first.requestId),f.at+100)
        assertEquals("visit.checkOut",f.store.history().last().first.kind)
        Unit
    }
    @Test fun F213_zeroDismissesAbsentProposalWithoutCreatingAnOrder() = runBlocking {
        assertNull(f.save(mapOf("p-absent" to 0L,"p-present" to 0L)))
        val p=JSONObject(f.store.history().last().first.serializedOperation).getJSONObject("payload")
        assertEquals("dismissed",p.getString("decision")); assertEquals(0L,p.getLong("quantityBase"))
        assertTrue(p.isNull("orderKey")); assertTrue(f.store.orderDrafts().isEmpty())
        f.reopen(); assertTrue(RetailQueueRules.saved(f.start.clientVisitId,f.backend.visitStates()))
        Unit
    }
    /** Retry after a local save whose UI refresh was interrupted must not prepare a second order. */
    @Test fun F213_repeatingSavedCallDoesNotDuplicateDraftOrProposal() = runBlocking {
        f.save()
        val before=f.store.history(); val drafts=f.store.orderDrafts()
        // Either an explicit already-saved refusal or an idempotent return is acceptable; new facts are not.
        runCatching { f.save() }
        assertEquals("A retry must retain the original check/proposal UUIDs",before,f.store.history())
        assertEquals("A retry must not prepare a second editable order",drafts,f.store.orderDrafts())
        Unit
    }
    @Test fun F213_negativeProposalRefusesBeforeAnyChecklistOrDraftWrite() = runBlocking {
        val before=f.store.history()
        val failure=runCatching { f.save(mapOf("p-absent" to -1L,"p-present" to 0L)) }.exceptionOrNull()
        assertNotNull("Backend must reject negative proposed quantities even when the UI is bypassed",failure)
        assertEquals(before,f.store.history()); assertTrue(f.store.orderDrafts().isEmpty())
        Unit
    }
    @Test fun F213_proposalWriteFailureRollsBackChecklistAndDraftTogether() = runBlocking {
        val before=f.store.history()
        f.db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_retail_proposal BEFORE INSERT ON intents WHEN NEW.kind='availability.proposal' BEGIN SELECT RAISE(ABORT,'retail test failure'); END")
        assertNotNull(runCatching { f.save() }.exceptionOrNull())
        assertEquals(before,f.store.history()); assertTrue(f.store.orderDrafts().isEmpty())
        assertFalse(RetailQueueRules.saved(f.start.clientVisitId,f.backend.visitStates()))
        f.db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_retail_proposal")
        assertNotNull(f.save()); assertEquals(3,f.store.history().size)
        Unit
    }
    @Test fun F212_scopeAndRejectedCheckCannotUnlockCheckout() = runBlocking {
        f.save()
        val other=RoomFieldStore(f.db,f.scope.copy(fingerprint="other"),closesDatabase=false)
        assertNull(RetailQueueRules.call(other,"outlet-retail")); assertTrue(other.history().isEmpty()); assertTrue(other.orderDrafts().isEmpty())
        val check=f.store.history().single { it.first.kind=="availability.record" }.first
        f.store.recordRejection(check.requestId,"invalid_request")
        assertFalse(RetailQueueRules.saved(f.start.clientVisitId,f.backend.visitStates()))
        assertEquals("Check every MSL line before ending the call",runCatching {
            f.store.enqueue(f.checkout(),f.at+100) }.exceptionOrNull()?.message)
        Unit
    }
    @Test fun F212_F213_uncertainSyncReplaysSameBytesAfterEncryptedReopen() = runBlocking {
        f.save()
        val original=f.store.history().map { it.first }
        val gateway=Gateway()
        val target=original.single { it.kind=="availability.record" }
        val interrupted=object : FieldStore by f.store {
            override suspend fun recordAck(requestId: String,entityId: String,eventIdsJson: String,serverTime: Long) {
                if(requestId==target.requestId) error("Interrupted after office acceptance")
                f.store.recordAck(requestId,entityId,eventIdsJson,serverTime)
            }
        }
        sync(gateway,interrupted).sync()
        assertNotNull(f.store.ack(f.start.requestId)); assertNull(f.store.ack(target.requestId))
        assertEquals(2,gateway.pushes.size)
        f.reopen(); sync(gateway,f.store).sync()
        assertEquals(4,gateway.pushes.size)
        assertArrayEquals(gateway.pushes[1],gateway.pushes[2])
        assertEquals(listOf("visit.checkIn","availability.record","availability.record","availability.proposal"),gateway.kinds)
        assertEquals(original.map { it.serializedOperation },f.store.history().map { it.first.serializedOperation })
        assertTrue(f.store.history().all { it.second.state=="done" })
        assertEquals(3,original.mapNotNull { f.store.ack(it.requestId) }.size)
        assertTrue(f.store.pending().isEmpty()); assertEquals(1,f.store.orderDrafts().size)
        Unit
    }
    private fun sync(gateway: Gateway,store: FieldStore)=VisitSync(SignedVisitGateway(gateway,f.signer,f.scope.deviceId,{0}),
        store,f.scope,bootstrap={error("No bootstrap expected")},now={f.at+100},pause={},jitter={0})
    private class Gateway : VisitTransport {
        val pushes=mutableListOf<ByteArray>(); val kinds=mutableListOf<String>()
        override fun token(refresh: Boolean)="test-only"
        override fun challenge(deviceId: String)=java.util.UUID.randomUUID().toString() to 60_100L
        override fun post(path: String,bytes: ByteArray,headers: Map<String,String>,bearer: String): Pair<Int,String> {
            if(path.endsWith("/pull"))return 200 to JSONObject().put("type","pull.response").put("contractVersion",1)
                .put("serverTime",150).put("nextCursor","retail-next").put("hasMore",false).put("changes",JSONArray()).toString()
            pushes+=bytes.copyOf()
            val operations=JSONObject(String(bytes)).getJSONArray("operations"); val results=JSONArray()
            for(i in 0 until operations.length()) {
                val op=operations.getJSONObject(i); val id=op.getString("clientRequestId"); val kind=op.getString("kind"); kinds+=kind
                if(kind!="visit.checkIn")assertEquals("server-retail-visit",op.getJSONObject("payload").getString("visitId"))
                results.put(JSONObject().put("kind",kind).put("clientRequestId",id).put("status","accepted")
                    .put("ack",JSONObject().put("entityId",if(kind=="visit.checkIn")"server-retail-visit" else "entity-$id")
                        .put("eventIds",JSONArray()).put("serverTime",150)))
            }
            return 200 to JSONObject().put("type","push.response").put("contractVersion",1).put("serverTime",150).put("results",results).toString()
        }
    }
}
