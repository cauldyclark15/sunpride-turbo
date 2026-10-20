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
    @Test fun F107_unconfiguredLegacyRowsKeepTheirOriginalBytes()=runBlocking {
        val legacy=row("visit.checkIn",JSONObject()).copy(serializedOperation="{\"kind\":\"visit.checkIn\"}")
        val store=object: FieldStore by FakeFieldStore(scope) {
            override suspend fun outlets()=listOf(SnapshotItem("store","outlet"))
            override suspend fun history()=listOf(legacy to OutboxRow(scope.account,scope.deviceId,scope.fingerprint,legacy.requestId,100))
        }
        for(kind in listOf("visit.checkIn","visit.activity","visit.checkOut")) {
            val intent=legacy.copy(kind=kind)
            assertEquals(intent,ConfiguredFieldCalls.prepare(store,intent))
        }
        assertNull(ConfiguredFieldCalls.config(store.history().map { it.first to it.second.state },"call"))
        assertFalse(ConfiguredFieldCalls.waitingForEvidence(store,legacy.copy(kind="visit.checkOut")))
        Unit
    }
    @Test fun F107_configuredStartIgnoresUnrelatedOpaqueHistoryWithoutBypassingItsOwnGuards()=runBlocking {
        val old=row("visit.activity",JSONObject()).copy(clientVisitId="old-call",serializedOperation="{\"kind\":\"visit.activity\"}")
        val store=object: FieldStore by FakeFieldStore(scope) {
            override suspend fun outlets()=listOf(SnapshotItem("store",JSONObject().put("callFlow",config()).toString()))
            override suspend fun history()=listOf(old to OutboxRow(scope.account,scope.deviceId,scope.fingerprint,old.requestId,100))
        }
        fun start(latitude:Double)=row("visit.checkIn",JSONObject().put("outletId","store").put("deviceTime",1000000)
            .put("location",JSONObject().put("latitude",latitude).put("longitude",123).put("accuracyMeters",5).put("fixTime",1000000).put("mockSignal",false).put("provider","gps")))
        assertEquals("flow",ConfiguredFieldCalls.payload(ConfiguredFieldCalls.prepare(store,start(10.0))).getString("flowDefinitionId"))
        var refused=false
        try { ConfiguredFieldCalls.prepare(store,start(11.0)) } catch(_:com.sunpride.callflow.CallFlowRefused) { refused=true }
        assertTrue(refused)
        assertEquals("{\"kind\":\"visit.activity\"}",old.serializedOperation)
        Unit
    }
    @Test fun F310_configuredCanonicalFormsDoNotDependOnLegacyIntentRules() {
        val c=config();c.getJSONObject("definition").put("channelProfile","merchandiser").put("steps",org.json.JSONArray("""[{"key":"in","adapter":"check_in","label":"Start","required":true,"condition":"always"},{"key":"availability","adapter":"availability","label":"Availability","required":true,"condition":"always"},{"key":"price","adapter":"price_check","label":"Price","required":false,"condition":"always"},{"key":"out","adapter":"check_out","label":"End","required":true,"condition":"always"}]"""))
        val rows=ConfiguredFieldCalls.retailActivityChecklist(c,emptyList(),setOf("merchandising")){it!="price_check"}
        assertEquals(listOf("merchandising","price_check"),rows.map {it.kind})
        assertEquals(ActivityRequirement.Status.DONE,rows[0].status);assertTrue(rows[0].required)
        assertEquals(ActivityRequirement.Status.UNAVAILABLE,rows[1].status);assertFalse(rows[1].required)
        c.getJSONObject("definition").getJSONArray("steps").getJSONObject(2).put("condition","has_order")
        assertEquals(listOf("merchandising"),ConfiguredFieldCalls.retailActivityChecklist(c,emptyList(),emptySet()){true}.map {it.kind})
    }
    @Test fun F107_F212_onlyACompletedCanonicalChecklistAdvancesTheSharedLocalFlow() {
        assertEquals("availability",ConfiguredFieldCalls.adapter(row("availability.record",JSONObject().put("complete",true))))
        assertNull(ConfiguredFieldCalls.adapter(row("availability.record",JSONObject().put("complete",false))))
        assertNull(ConfiguredFieldCalls.adapter(row("availability.record",JSONObject())))
    }
    @Test fun F310_otherChannelsAndUnconfiguredCallsKeepTheSameLegacyChecklist() {
        val legacy=listOf(ActivityRequirement("note",true,ActivityRequirement.Status.TO_DO))
        assertSame(legacy,ConfiguredFieldCalls.retailActivityChecklist(null,legacy,emptySet()){true})
        assertSame(legacy,ConfiguredFieldCalls.retailActivityChecklist(config(),legacy,emptySet()){true})
    }
    @Test fun F318_merchandiserCannotReplaceCampaignChecklistWithLegacyPromotion()=runBlocking {
        val c=config().also { it.getJSONObject("definition").put("channelProfile","merchandiser") }
        val start=row("visit.checkIn",JSONObject().put("callFlowSnapshot",c).put("deviceTime",100).put("outletId","store"))
        val promotion=row("visit.activity",JSONObject().put("activity",JSONObject().put("kind","promotion").put("finding","executed")).put("deviceTime",200))
        val store=object: FieldStore by FakeFieldStore(scope) {
            override suspend fun history()=listOf(start to OutboxRow(scope.account,scope.deviceId,scope.fingerprint,start.requestId,100))
        }
        var message:String?=null
        try {ConfiguredFieldCalls.prepare(store,promotion)} catch(e:IllegalStateException) {message=e.message}
        assertEquals("Use the campaign checklist for this call",message)
        Unit
    }
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
