package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class RetailCaptureQueueTest {
    private val identity=StoreScope("sample-account","sample-device","sample-scope")
    private fun snapshot()=JSONObject().put("equipment",JSONArray().put(JSONObject().put("id","asset-version").put("data",JSONObject().put("serial","SERIAL-1"))))
        .put("masters",JSONArray().put(JSONObject().put("id","expiry-policy").put("kind","expiry_policy").put("data",JSONObject().put("productId","product"))))
    private fun freezer()=JSONObject().put("equipmentVersionId","asset-version").put("scannedSerial","SERIAL-1")
        .put("temperatureDeciC",-185).put("ownSharePercent",95).put("measuredAt",10000L)
    private fun start()=IntentRow(identity.account,identity.deviceId,identity.fingerprint,"check-in","visit","visit.checkIn","{}",9000)
    private fun intent()=RetailCaptureQueue.create(identity,start(),"previous","freezer",freezer(),listOf("photo"),10000)
    private fun photo(state: String="pending",evidence: String?=null)=EvidencePhotoRow(identity.account,identity.deviceId,identity.fingerprint,"photo","visit","check-in","outlet","shelf_display","image/jpeg",100,"a".repeat(64),10000,10000,state=state,evidenceId=evidence)
    @Test fun F310_opaqueUnconfiguredPersistenceRowsKeepTheirOriginalBytes() = kotlinx.coroutines.runBlocking {
        val row=IntentRow(identity.account,identity.deviceId,identity.fingerprint,"legacy","visit","visit.activity","{}",10000)
        val store=com.sunpride.field.support.FakeFieldStore(identity)
        assertEquals(row,ConfiguredFieldCalls.prepare(store,row))
    }
    @Test fun F310_opaqueLegacyOutletDoesNotInventAConfiguration() = kotlinx.coroutines.runBlocking {
        val store=com.sunpride.field.support.FakeFieldStore(identity)
        val generation=store.stage(ScopedSnapshot("{}",null,emptyList(),listOf(SnapshotItem("outlet","outlet")),emptyList(),emptyList()))
        store.swap(generation,"cursor",20000,20000)
        val row=start().copy(serializedOperation=JSONObject().put("payload",JSONObject().put("outletId","outlet").put("deviceTime",10000)).toString())
        assertEquals(row,ConfiguredFieldCalls.prepare(store,row))
        val bad=store.stage(ScopedSnapshot("{}",null,emptyList(),listOf(SnapshotItem("outlet","{broken")),emptyList(),emptyList()))
        store.swap(bad,"cursor",20000,20000)
        var refused=false
        try {ConfiguredFieldCalls.prepare(store,row)}catch(_:org.json.JSONException){refused=true}
        assertTrue("Malformed configured JSON must not become an authorization bypass",refused)
    }
    @Test fun F315_signedNegativeTemperatureAndSerialAreValidated() {
        RetailCaptureQueue.validateData("freezer",freezer(),snapshot(),10001)
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("freezer",freezer().put("ownSharePercent",101),snapshot(),10001)}
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("freezer",freezer().put("scannedSerial","FOREIGN"),snapshot(),10001)}
    }
    @Test fun F315_staleOrFractionalMeasurementsAreRefused() {
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("freezer",freezer(),snapshot(),3_610_001)}
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("freezer",freezer().put("temperatureDeciC",-18.5),snapshot(),10001)}
    }
    @Test fun F320_expiryNeedsRealDateQuantityAndGovernedProduct() {
        val d=JSONObject().put("lines",JSONArray().put(JSONObject().put("productId","product").put("batch","BATCH-X").put("expiryDate","2026-10-31").put("quantityBase",12)))
        RetailCaptureQueue.validateData("expiry",d,snapshot(),10001)
        assertThrows(Exception::class.java){RetailCaptureQueue.validateData("expiry",JSONObject(d.toString()).also { it.getJSONArray("lines").getJSONObject(0).put("expiryDate","2026-02-30") },snapshot(),10001)}
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("expiry",JSONObject(d.toString()).also { it.getJSONArray("lines").getJSONObject(0).put("quantityBase",0) },snapshot(),10001)}
    }
    @Test fun F310_offlinePhotoAndCheckinReferencesNeverBecomeInventedServerIdentifiers() {
        val row=intent();val p=JSONObject(row.serializedOperation).getJSONObject("payload")
        assertEquals("@checkin:check-in",p.getString("visitId"));assertEquals("photo",p.getJSONArray("localPhotoIds").getString(0))
        assertEquals(row.requestId,p.getString("requestKey"));assertEquals(RetailCaptureQueue.KIND,row.kind)
    }
    @Test fun F315_waitForTheExactUploadedPhotoInsteadOfDroppingTheAudit() {
        assertNull(RetailCaptureQueue.materialize(intent(),listOf(photo())))
        assertNull(RetailCaptureQueue.materialize(intent(),listOf(photo("review"))))
        assertNull(RetailCaptureQueue.materialize(intent(),listOf(photo("uploaded","evidence").copy(clientVisitId="other"))))
    }
    @Test fun F310_F315_ackReplayMaterializesIdenticalBytesWithoutChangingDurableIntent() {
        val row=intent();val before=row.serializedOperation;val photos=listOf(photo("uploaded","server-evidence"))
        val a=checkNotNull(RetailCaptureQueue.materialize(row,photos));val b=checkNotNull(RetailCaptureQueue.materialize(row,photos))
        assertEquals(a.toString(),b.toString());assertEquals(before,row.serializedOperation)
        assertFalse(a.getJSONObject("payload").has("localPhotoIds"));assertEquals("server-evidence",a.getJSONObject("payload").getJSONObject("data").getJSONArray("evidenceIds").getString(0))
    }
    @Test fun F317_F321_explicitNoObservationIsNotAClaimOfPhotographicEvidence() {
        for(kind in listOf("competitor","issue_log")) {
            val d=JSONObject().put("noneObserved",true);RetailCaptureQueue.validateData(kind,d,snapshot(),10001)
            assertFalse(RetailCaptureQueue.needsPhoto(kind,d))
        }
        assertTrue(RetailCaptureQueue.needsPhoto("freezer",freezer()))
    }
    @Test fun F311_countsFreezeTargetVersionAndRefuseIncompleteProductSets() {
        val target=JSONObject().put("id","layout").put("data",JSONObject().put("lines",JSONArray().put(JSONObject().put("productId","product").put("facings",3).put("position","Shelf 1"))))
        val s=snapshot().put("planogram",target)
        val d=JSONObject().put("masterVersionId","layout").put("lines",JSONArray().put(JSONObject().put("productId","product").put("facings",2).put("position","Shelf 1"))).put("ownFacings",2).put("totalFacings",6)
        RetailCaptureQueue.validateData("planogram",d,s,10001)
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("planogram",JSONObject(d.toString()).put("ownFacings",3),s,10001)}
        assertThrows(IllegalArgumentException::class.java){RetailCaptureQueue.validateData("planogram",JSONObject(d.toString()).put("masterVersionId","other"),s,10001)}
    }
}
