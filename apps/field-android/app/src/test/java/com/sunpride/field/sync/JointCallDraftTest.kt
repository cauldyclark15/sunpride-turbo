package com.sunpride.field.sync

import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.JointCallDraft
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class JointCallDraftTest {
 @Test fun F223_actualSignedProjectionAndImmutableDraftKeepStructuredCoachingAndCarryFacts(){
  val wire=JSONObject(javaClass.classLoader!!.getResource("jointcall-native-v2.json")!!.readText())
  val me=wire.getJSONObject("me");val response=wire.getJSONObject("response")
  val data=response.getJSONArray("bundles").getJSONObject(0).getJSONObject("data")
  val day=data.getString("serviceDate")
  val bundle=V2Wire.bundle(response,me,"field.jointcall",JSONObject().put("serviceDate",day))
  assertTrue(bundle.getBoolean("complete"))
  assertEquals("Prepare the next call",data.getJSONArray("trainees").getJSONObject(0).getJSONArray("carried").getJSONObject(0).getString("agreement"))
  val captured=wire.getJSONObject("captured").getJSONObject("payload")
  val draft=JointCallDraft.payload(captured,false)
  assertFalse(draft.getBoolean("complete"));assertTrue(captured.getBoolean("complete"))
  val scope=StoreScope("test-coach","test-device",me.getJSONObject("scope").getString("fingerprint"))
  val intent=DomainOutbox.intent(scope,"jointcall.capture",draft,"test-session",at=1234)
  draft.getJSONObject("trainingLog").put("topics","Later editing must not rewrite the queued form")
  val frozen=JSONObject(intent.serializedOperation).getJSONObject("payload")
  assertEquals("Call preparation",frozen.getJSONObject("trainingLog").getString("topics"))
  assertEquals(2,frozen.getJSONArray("observations").length())
  assertEquals("trainee",frozen.getJSONArray("actions").getJSONObject(0).getString("owner"))
  val empty=JointCallDraft.create(day,null)
  assertEquals(0,empty.getJSONArray("observations").length());assertFalse(empty.getJSONObject("trainingLog").getBoolean("discussedWithTrainee"))
 }
 // FLD-159: "Save and finish" on a training joint call with only a BCP observation, topics and trade development
 // queued a finish the office refused with no words. The phone now names the same missing parts first.
 @Test fun `FLD-159 finish names the missing parts and a complete form is not blocked`(){
  val a=JointCallDraft.create("2026-11-13",null).put("traineeProfileId","t")
  a.getJSONArray("observations").put(JSONObject().put("area","bcp").put("item","Greet").put("rating","met").put("remark","ok"))
  a.getJSONObject("trainingLog").put("topics","Call steps").put("tradeDevelopment","Shelf order")
  val gaps=JointCallDraft.gaps(a)
  assertEquals(listOf("Record at least one Persuasive Selling Format (PSF) observation",
   "Review and discuss the training log with the trainee"),gaps)
  assertTrue(JointCallDraft.finishBlocked(gaps)!!.startsWith("Not finished yet. Record at least one Persuasive"))
  a.getJSONArray("observations").put(JSONObject().put("area","psf").put("item","Benefit").put("rating","partial"))
  a.getJSONObject("trainingLog").put("discussedWithTrainee",true)
  assertTrue(JointCallDraft.gaps(a).isEmpty());assertNull(JointCallDraft.finishBlocked(JointCallDraft.gaps(a)))
  val sales=JointCallDraft.create("2026-11-13",null).put("objective","sales_validation").put("mode","truck")
  assertTrue(JointCallDraft.gaps(sales).containsAll(listOf("Write all four SWOT remarks after the call","Confirm you rode the named truck")))
  assertEquals("The joint call is missing a required part. Open it, fill in what it lists and Save and finish again",
   com.sunpride.field.ui.syncstatus.SyncStatus.plainReason("work_with_incomplete"))
 }
}
