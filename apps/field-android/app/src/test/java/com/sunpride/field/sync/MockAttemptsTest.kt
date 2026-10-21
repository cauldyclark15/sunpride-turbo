package com.sunpride.field.sync

import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class MockAttemptsTest {
 @Test fun F221_offlineMockRefusalUploadsIndependentlyWithoutAnInventedCheckIn() = runBlocking {
  val identity=StoreScope("sample-person","sample-device","sample-scope")
  val store=FakeFieldStore(identity)
  val snapshot=ScopedSnapshot("{}",null,emptyList(),emptyList(),emptyList(),emptyList())
  store.swap(store.stage(snapshot),"cursor",100000,100000)
  val intent=MockAttempts.create(identity,UUID.randomUUID().toString(),1000)
  store.enqueue(intent,1000)
  val original=intent.serializedOperation
  val transport=object:VisitTransport {
   override fun challenge(deviceId:String)=UUID.randomUUID().toString() to 61000L
   override fun token(refresh:Boolean)="sample-token"
   override fun post(path:String,bytes:ByteArray,headers:Map<String,String>,bearer:String):Pair<Int,String> {
    if(path.endsWith("pull")) return 200 to JSONObject().put("type","pull.response").put("contractVersion",1).put("serverTime",1000).put("changes",JSONArray()).put("nextCursor","cursor-next").put("hasMore",false).toString()
    val op=JSONObject(bytes.toString(Charsets.UTF_8)).getJSONArray("operations").getJSONObject(0)
    assertEquals(MockAttempts.KIND,op.getString("kind"));assertEquals(0,op.getJSONArray("dependsOn").length())
    assertEquals(setOf("deviceTime","outletId","mockSignal"),op.getJSONObject("payload").keys().asSequence().toSet())
    val result=JSONObject().put("clientRequestId",intent.requestId).put("kind",intent.kind).put("status","accepted").put("ack",JSONObject().put("entityId","sample-observation").put("eventIds",JSONArray()).put("serverTime",1000))
    return 200 to JSONObject().put("type","push.response").put("contractVersion",1).put("serverTime",1000).put("results",JSONArray().put(result)).toString()
   }
  }
  val signer=object:DeviceSigner {
   override val publicKeySpki=byteArrayOf(1)
   override val protection=KeyProtection.SOFTWARE
   override fun signDer(message:ByteArray)=byteArrayOf()
   override fun sign(message:String)=message
  }
  assertTrue(VisitSync(SignedVisitGateway(transport,signer,identity.deviceId),store,identity,{},now={1000}).sync())
  assertEquals("done",store.history().single().second.state)
  assertEquals(original,store.history().single().first.serializedOperation)
  assertTrue(store.history().none {it.first.kind=="visit.checkIn"})
 }
}
