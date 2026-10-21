package com.sunpride.catalogue

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class SapMasterMirrorTest {
 private val binding=SapMasterMirror.Binding("field-android","sample-device","sample-unit","sample-scope")
 private fun row(id:String=UUID.randomUUID().toString(),revision:Long=1,version:Long=1)=JSONObject()
  .put("id",id).put("revision",revision).put("version",version).put("source","sample").put("key","SAMPLE").put("kind","material")
  .put("effectiveFrom",java.time.Instant.parse("2026-01-01T00:00:00Z").toEpochMilli()).put("effectiveTo",JSONObject.NULL).put("receivedAt",1234).put("data",JSONObject().put("name","SAMPLE product"))
 private fun page(rows:List<JSONObject>,more:Boolean=false,delta:Boolean=false)=JSONObject().put("version",2).put("serverTime",1234)
  .put("hasMore",more).put("nextCursor","sample-cursor").put("nextPageCursor",if(more)"sample-page" else JSONObject.NULL)
  .put("bundles",JSONArray().put(JSONObject().put("scopeId",binding.scopeId).put("projection","sap.masters").apply {
   if(delta)put("changes",JSONArray(rows)) else put("data",JSONObject().put("masters",JSONArray(rows)))
  }))
 @Test fun F004_snapshotPagesDeltaRevisionsAndTombstoneKeepSapProvenance() {
  val first=row();val second=row();var pages=0
  val state=SapMasterMirror.refresh(binding,null,{request->
   if(pages++==0){assertTrue(request.isNull("since"));page(listOf(first),true)} else {assertEquals("sample-page",request.getString("pageCursor"));page(listOf(second))}
  },{true})
  assertEquals(2,state.getJSONArray("masters").length())
  val changed=row(first.getString("id"),3,2)
  val delta=page(listOf(JSONObject().put("entity","sap.master").put("id",first.getString("id")).put("revision",3).put("op","upsert").put("value",changed),
   JSONObject().put("entity","sap.master").put("id",second.getString("id")).put("revision",4).put("op","tombstone").put("value",JSONObject.NULL)),delta=true)
  val updated=SapMasterMirror.refresh(binding,state,{request->assertEquals("sample-cursor",request.getString("since"));delta},{true})
  assertEquals(1,updated.getJSONArray("masters").length())
  assertEquals(2,updated.getJSONArray("masters").getJSONObject(0).getLong("version"))
  assertEquals("sample",updated.getJSONArray("masters").getJSONObject(0).getString("source"))
  assertEquals(2,state.getJSONArray("masters").length())
 }
 @Test fun F004_incompleteSnapshotAndRetiredRequestNeverPublish() {
  var active=true
  try {SapMasterMirror.refresh(binding,null,{active=false;page(listOf(row()))},{active});fail("retired")}catch(_:IllegalStateException){}
  try {SapMasterMirror.refresh(binding,null,{page(listOf(row()),true)},{true});fail("paging loop")}catch(_:IllegalArgumentException){}
 }
 private class Grants: SapMasterGrants {
  var granted=true;var canRevoke=true
  override fun allowed(key:String)=granted
  override fun revoke(key:String):Boolean {if(!canRevoke)return false;granted=false;return true}
  override fun permit(key:String):Boolean {granted=true;return true}
 }
 @Test fun F004_writeAheadRevocationKeepsReadableOldCacheHiddenAfterDenialAndBlocksNetworkIfItFails() {
  val grants=Grants();val access=SapMasterAccess(grants)
  var raw=SapMasterMirror.refresh(binding,null,{page(listOf(row()))},{true}).toString()
  try {access.refresh("sample-key",binding,{raw},{raw=it},{throw IllegalStateException("denied")},{true},{true});fail("denied")}catch(_:IllegalStateException){}
  assertNull(access.cached("sample-key",{raw},{true}))
  assertEquals(1,JSONObject(raw).getJSONArray("masters").length())
  grants.granted=true;grants.canRevoke=false;var contacted=false
  try {access.refresh("sample-key",binding,{raw},{raw=it},{contacted=true;page(emptyList())},{true},{true});fail("grant write")}catch(_:IllegalStateException){}
  assertFalse(contacted)
 }
}
