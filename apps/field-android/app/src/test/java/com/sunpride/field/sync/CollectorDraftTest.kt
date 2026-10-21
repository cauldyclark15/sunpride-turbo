package com.sunpride.field.sync

import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.CollectorDraft
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class CollectorDraftTest {
 @Test fun F613_actualSignedAgendaKeepsUnknownArAndImmutableMoneyEvidence(){
  val wire=JSONObject(javaClass.classLoader!!.getResource("collector-native-v2.json")!!.readText())
  val me=wire.getJSONObject("me");val response=wire.getJSONObject("response")
  val data=response.getJSONArray("bundles").getJSONObject(0).getJSONObject("data")
  val day=data.getString("serviceDate")
  assertTrue(V2Wire.bundle(response,me,"field.collections",JSONObject().put("serviceDate",day)).getBoolean("complete"))
  assertTrue(data.getJSONArray("stops").getJSONObject(1).isNull("ar"))
  assertTrue(data.getJSONArray("stops").getJSONObject(0).getJSONObject("ar").getString("source").contains("SAMPLE"))
  val request=wire.getJSONArray("requests").getJSONObject(0).getJSONObject("payload")
  assertEquals(request.getLong("amountMinor"),CollectorDraft.minor("10.00"))
  assertThrows(IllegalArgumentException::class.java){CollectorDraft.minor("1.001")}
  assertThrows(IllegalArgumentException::class.java){CollectorDraft.minor("-1")}
  val pickup=wire.getJSONArray("requests").getJSONObject(1).getJSONObject("payload")
  val captured=CollectorDraft.payload("cheque.receive",day,pickup.getString("customerCode"),pickup.getString("note"))
   .put("photo",pickup.getJSONObject("photo")).put("chequeDate",pickup.getString("chequeDate"))
  val intent=DomainOutbox.intent(StoreScope("test-collector","test-device",me.getJSONObject("scope").getString("fingerprint")),"collections.capture",captured,"test-capture",at=1234)
  captured.getJSONObject("photo").put("bytesBase64","later mutation")
  val frozen=JSONObject(intent.serializedOperation).getJSONObject("payload")
  assertEquals(wire.getJSONObject("evidence").getJSONArray("items").getJSONObject(0).getJSONObject("photo").getString("bytesBase64"),frozen.getJSONObject("photo").getString("bytesBase64"))
  assertEquals(pickup.getString("chequeDate"),frozen.getString("chequeDate"))
 }
}
