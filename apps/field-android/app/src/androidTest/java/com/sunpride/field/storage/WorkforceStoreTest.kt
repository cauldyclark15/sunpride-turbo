package com.sunpride.field.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** F-209/F-222: real SQLCipher/Room, with synthetic camera bytes; live camera proof is separate. */
@RunWith(AndroidJUnit4::class)
class WorkforceStoreTest {
    private lateinit var db: StoreDatabase
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private val scope=StoreScope("workforce-test-${UUID.randomUUID()}","test-device","test-scope")
    private val at=System.currentTimeMillis()
    private fun target()=RoomFieldStore(db,scope)
    @Before fun open(){db=EncryptedFieldDatabase.open(context)}
    @After fun close(){
        for(table in listOf("evidence_photos","acks","outbox","intents","snapshots","partitions"))
            db.openHelper.writableDatabase.execSQL("DELETE FROM $table WHERE account=? AND deviceId=? AND scope=?",arrayOf(scope.account,scope.deviceId,scope.fingerprint))
        db.close()
    }
    private fun policyJson(): JSONObject {
        val fields=JSONArray()
        for(key in listOf("address","channel","contactName"))fields.put(JSONObject().put("key",key).put("label",key).put("type","text").put("required",true).put("maxLength",100).put("options",JSONArray()))
        return JSONObject().put("policyId","11111111-1111-4111-8111-111111111111").put("version",1).put("contentHash","a".repeat(64))
            .put("label","SAMPLE fixture").put("sourceRef","TEST").put("validFrom",at-1000).put("expiresAt",at+600000)
            .put("canProspect",true).put("canClock",true).put("clockInRequestId",JSONObject.NULL).put("clockInAt",JSONObject.NULL).put("clockOutAt",JSONObject.NULL)
            .put("configuration",JSONObject().put("fields",fields).put("maxFixAgeSeconds",300))
    }
    private suspend fun ready(): RoomFieldStore {
        val s=target();val employee=JSONObject().put("id","fixture-person").put("workforceNegotiated",true).put("workforce",policyJson()).toString()
        val generation=s.stage(ScopedSnapshot(employee,null,emptyList(),emptyList(),emptyList(),emptyList()))
        // Visit recording is closed; this separately granted non-call capture remains authorized.
        s.swap(generation,"test-cursor",at-1,at+600000)
        return s
    }
    private fun capture(): Pair<IntentRow,EvidencePhotoRow?> = WorkforceForms.create(scope,WorkforcePolicy.decode(policyJson()),"workforce.prospect","SAMPLE offline prospect",mapOf("address" to "SAMPLE","channel" to "GT","contactName" to "SAMPLE"),JSONObject().put("latitude",10.33).put("longitude",123.94).put("accuracyMeters",5).put("fixTime",at).put("mockSignal",false).put("provider","gps"),byteArrayOf(0xff.toByte(),0xd8.toByte(),1,0xff.toByte(),0xd9.toByte()),at,at,null,false)
    @Test fun `F-209_F-222_pre_feature_cache_must_bootstrap_once_before_reusing_its_cursor`()=runBlocking {
        val s=ready();assertTrue(s.workforceSnapshotCurrent())
        val g=s.stage(ScopedSnapshot(JSONObject().put("id","fixture-person").toString(),null,emptyList(),emptyList(),emptyList(),emptyList()))
        s.swap(g,"legacy-cursor",at-1,at+600000)
        assertFalse(s.workforceSnapshotCurrent());assertNull(s.workforcePolicy())
    }
    @Test fun `F-209_atomic_form_photo_and_outbox_survive_reopen_without_a_visit_lease`()=runBlocking {
        val s=ready();assertFalse(s.isLeaseValid(at));val (intent,photo)=capture();s.enqueueWorkforce(intent,photo,at)
        db.close();db=EncryptedFieldDatabase.open(context)
        assertEquals(intent.serializedOperation,target().history().single().first.serializedOperation)
        assertEquals(photo,target().pendingPhotos().single())
        target().holdForReview();assertTrue(target().isHeld())
        assertEquals(1,target().pending().size);assertNull(target().workforcePolicy())
        assertEquals(intent.serializedOperation,target().history().single().first.serializedOperation)
    }
    @Test fun `F-209_authority_retirement_rolls_back_all_three_rows`()=runBlocking {
        val s=ready();val (intent,photo)=capture();var checks=0
        assertThrows(IllegalStateException::class.java){runBlocking {s.enqueueWorkforce(intent,photo,at){++checks<2}}}
        assertTrue(s.history().isEmpty());assertTrue(s.pendingPhotos().isEmpty());assertTrue(s.pending().isEmpty())
        Unit
    }
    @Test fun `F-222_uploaded_form_media_is_retained_until_transactional_aggregate_ack`()=runBlocking {
        val s=ready();val (intent,photo)=capture();s.enqueueWorkforce(intent,photo,at)
        s.markPhotoUploaded(intent.requestId,"server-blob",at)
        assertThrows(IllegalStateException::class.java){runBlocking{s.forgetUploadedFormPhoto(intent.requestId)}}
        assertEquals(1,s.visitPhotos(intent.requestId).size)
        s.markSending(listOf(intent.requestId));s.recordAck(intent.requestId,"server-enrolment","[]",at)
        s.forgetUploadedFormPhoto(intent.requestId)
        assertTrue(s.visitPhotos(intent.requestId).isEmpty());assertNotNull(s.ack(intent.requestId))
    }
}
