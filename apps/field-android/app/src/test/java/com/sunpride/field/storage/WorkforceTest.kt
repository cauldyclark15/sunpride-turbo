package com.sunpride.field.storage

import com.sunpride.field.ui.BackNavigation
import com.sunpride.field.ui.BackState
import com.sunpride.field.ui.BackStep
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class WorkforceTest {
    private val at=java.time.Instant.parse("2026-10-20T15:15:00Z").toEpochMilli()
    private val scope=StoreScope("person","device","scope")
    private val jpeg=byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),0xe0.toByte(),0,0,0xff.toByte(),0xd9.toByte())
    private fun policy()=WorkforcePolicy("11111111-1111-4111-8111-111111111111",1,"a".repeat(64),"SAMPLE form","TEST",at-1000,at+60000,true,true,
        listOf(WorkforceField("address","Address","text",true,500,emptyList()),WorkforceField("channel","Channel","select",true,100,listOf("GT")),WorkforceField("contactName","Contact","text",true,100,emptyList()),WorkforceField("reference","Reference","text",false,30,emptyList())),300,null,null,null)
    private fun geo()=JSONObject().put("latitude",10.33).put("longitude",123.94).put("accuracyMeters",5).put("fixTime",at).put("provider","gps").put("mockSignal",false)
    private val answers=mapOf("address" to "SAMPLE address","channel" to "GT","contactName" to "SAMPLE contact","reference" to "0005")
    @Test fun `F-209_TemplateKeepsKycAndPhotoButDoesNotInventServerIds`() {
        val (intent,photo)=WorkforceForms.create(scope,policy(),"workforce.prospect","SAMPLE prospect",answers,geo(),jpeg,at,at,null,false)
        val p=WorkforceForms.payload(intent)
        assertEquals("0005",p.getJSONObject("kyc").getString("reference"))
        assertFalse(p.has("visitId"));assertFalse(p.has("outletId"));assertFalse(p.getJSONObject("photo").has("blobId"))
        assertEquals(intent.requestId,photo!!.localId);assertEquals("prospect-photo",WorkforceForms.purpose(photo.photoType))
        assertEquals(at,p.getJSONObject("geo").getLong("takenAt"))
    }
    @Test fun `F-209_MissingRequiredKycRefusesWithoutChangingInput`() {
        assertThrows(IllegalArgumentException::class.java) {WorkforceForms.create(scope,policy(),"workforce.prospect","Store",answers-"address",geo(),jpeg,at,at,null,false)}
        assertEquals("0005",answers["reference"])
    }
    @Test fun `F-209_ExpiredPolicyCannotAuthorizeMoreOfflineForms`() {
        assertThrows(IllegalArgumentException::class.java) {WorkforceForms.create(scope,policy().copy(expiresAt=at),"workforce.prospect","Store",answers,geo(),jpeg,at,at,null,false)}
    }
    @Test fun `F-222_ClockInAndOutUseTheSameOutboxWithARealParentRequestReference`() {
        val (start,photo)=WorkforceForms.create(scope,policy(),"workforce.clockIn","",emptyMap(),geo(),jpeg,at,at,null,false)
        assertEquals("attendance-photo",WorkforceForms.purpose(photo!!.photoType))
        val view=WorkforceForms.view(policy(),listOf(start to "pending"),at)
        assertFalse(view.canClockIn(at));assertTrue(view.canClockOut(at))
        val (end,noPhoto)=WorkforceForms.create(scope,policy(),"workforce.clockOut","",emptyMap(),null,null,0,at+1000,view.clockInRequestId,true)
        assertNull(noPhoto);assertEquals(start.requestId,WorkforceForms.payload(end).getString("clockInRequestId"))
        assertEquals(start.requestId,JSONObject(end.serializedOperation).getJSONArray("dependsOn").getString(0))
        assertFalse(WorkforceForms.view(policy(),listOf(start to "pending",end to "pending"),at+1000).canClockOut(at+1000))
    }
    @Test fun `F-222_RejectedClockInDoesNotPretendTheDayIsOpen`() {
        val start=WorkforceForms.create(scope,policy(),"workforce.clockIn","",emptyMap(),geo(),jpeg,at,at,null,false).first
        assertFalse(WorkforceForms.view(policy(),listOf(start to "review"),at).canClockOut(at))
    }
    @Test fun `F-222_StaleLocationAndPhotoAreNotSilentlyRestamped`() {
        assertThrows(IllegalArgumentException::class.java) {WorkforceForms.create(scope,policy(),"workforce.clockIn","",emptyMap(),geo().put("fixTime",at-301000),jpeg,at,at,null,false)}
        assertThrows(IllegalArgumentException::class.java) {WorkforceForms.create(scope,policy(),"workforce.clockIn","",emptyMap(),geo(),jpeg,at-301000,at,null,false)}
    }
    @Test fun `F-209_F-222_BackReturnsToTodayNotOutOfTheApp`() {
        assertEquals(BackStep.ToPage("home"),BackNavigation.step(BackState(page="workforce")))
    }
}
