package com.sunpride.catalogue

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** F-004: opt-in bridge proof consumes the exact signed API response, not a hand-written DTO. */
class SapMasterWireTest {
 @Test fun F004_nativeDecoderAcceptsTheActualSapMasterProjectionPacket() {
  val path=System.getenv("SP_NATIVE_MASTER_WIRE")
  assumeTrue("Run the small finish-master-copy API fixture first",path!=null)
  val response=JSONObject(File(path!!).readText())
  val bundle=response.getJSONArray("bundles").getJSONObject(0)
  val binding=SapMasterMirror.Binding("van-android","fixture-device",bundle.getString("scopeId"),bundle.getString("scopeFingerprint"))
  val decoded=SapMasterMirror.refresh(binding,null,{response},{true})
  val row=decoded.getJSONArray("masters").getJSONObject(0)
  assertEquals("sample",row.getString("source"))
  assertEquals("location",row.getString("kind"))
  assertEquals("SAMPLE-TRUCK",row.getJSONObject("data").getString("locationCode"))
  assertEquals(1,SapMasterMirror.current(decoded).size)
 }
}
