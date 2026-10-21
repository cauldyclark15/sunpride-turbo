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
}
