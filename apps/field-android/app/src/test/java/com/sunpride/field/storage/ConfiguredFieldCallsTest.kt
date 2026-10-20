package com.sunpride.field.storage

import com.sunpride.field.support.FakeFieldStore
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ConfiguredFieldCallsTest {
    private val scope=StoreScope("account","device","scope")
    private fun config()=JSONObject("""{"definition":{"id":"flow","channelProfile":"field_selling","version":1,"steps":[{"key":"in","adapter":"check_in","label":"Start","required":true,"condition":"always"},{"key":"photo","adapter":"evidence","label":"Photo","required":true,"condition":"always"},{"key":"out","adapter":"check_out","label":"End","required":true,"condition":"always"}]},"policy":{"radiusMeters":100,"maxAccuracyMeters":50,"maxFixAgeMs":60000,"minDwellMs":0},"pin":{"latitude":10,"longitude":123},"reasons":[{"code":"no_demand","label":"No demand"}],"geofenceApprovals":[]}""")
    private fun row(kind:String,p:JSONObject)=IntentRow(scope.account,scope.deviceId,scope.fingerprint,kind,"call",kind,JSONObject().put("payload",p).toString(),200)
    @Test fun F107_requiredOfflinePhotoKeepsEndBytesQueuedUntilActualAttachment()=runBlocking {
        val start=row("visit.checkIn",JSONObject().put("callFlowSnapshot",config()).put("deviceTime",100).put("outletId","store"))
        val out=row("visit.checkOut",JSONObject().put("deviceTime",200).put("zeroSaleReason","no_demand").put("location",JSONObject().put("latitude",10).put("longitude",123).put("accuracyMeters",5).put("fixTime",200).put("mockSignal",false).put("provider","gps")))
        var photos=emptyList<EvidencePhotoRow>()
        val store=object: FieldStore by FakeFieldStore(scope) {
            override suspend fun history()=listOf(start to OutboxRow(scope.account,scope.deviceId,scope.fingerprint,start.requestId,100))
            override suspend fun visitPhotos(clientVisitId:String)=photos
        }
        var refused=false
        try { ConfiguredFieldCalls.prepare(store,out) } catch(_:IllegalStateException) { refused=true } catch(_:IllegalArgumentException) { refused=true }
        assertTrue("A required photo cannot be self-certified by End",refused)
        photos=listOf(EvidencePhotoRow(scope.account,scope.deviceId,scope.fingerprint,"photo","call",start.requestId,"store","shelf","image/jpeg",10,"a".repeat(64),150,150))
        assertEquals(out.serializedOperation,ConfiguredFieldCalls.prepare(store,out).serializedOperation)
        assertTrue("Capture is durable locally; End waits for the actual media adapter",ConfiguredFieldCalls.waitingForEvidence(store,out))
        photos=photos.map { it.copy(state="uploaded",evidenceId="server-evidence") }
        assertFalse(ConfiguredFieldCalls.waitingForEvidence(store,out))
        photos=photos.map { it.copy(state="review",evidenceId=null) }
        assertTrue(ConfiguredFieldCalls.waitingForEvidence(store,out))
        Unit
    }
}
