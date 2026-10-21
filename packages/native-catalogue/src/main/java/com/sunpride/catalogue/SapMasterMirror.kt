package com.sunpride.catalogue

import org.json.JSONObject
import org.json.JSONArray

/** F-004/F-015: complete authorized SAP master snapshot/delta. This is not a second price engine. */
object SapMasterMirror {
 const val MAX_ROWS=10000
 const val MAX_BYTES=10*1024*1024
 data class Binding(val app:String,val deviceId:String,val scopeId:String,val fingerprint:String)
 /** Stages every page in memory; caller commits this one JSON value and cursor atomically. */
 fun refresh(binding:Binding,previous:JSONObject?,pull:(JSONObject)->JSONObject,isCurrent:()->Boolean):JSONObject {
  check(isCurrent()) {"Master authorization changed"}
  val rows=linkedMapOf<String,JSONObject>();val revisions=linkedMapOf<String,Long>()
  val prior=previous?.takeIf {it.optString("binding")==binding.fingerprint}
  prior?.optJSONObject("revisions")?.let {r->r.keys().forEach {revisions[it]=r.getLong(it)}}
  prior?.optJSONArray("masters")?.let {a->for(i in 0 until a.length()) {val r=a.getJSONObject(i);rows[r.getString("id")]=r}}
  val since=prior?.optString("cursor")?.takeIf {it.isNotBlank()}
  var page:String?=null;var cursor:String?=null;var serverTime=0L
  val visited=mutableSetOf<String>();var complete=false
  for(index in 0 until 200) {
   check(isCurrent()) {"Master authorization changed"}
   val request=JSONObject().put("version",2).put("app",binding.app).put("deviceId",binding.deviceId)
    .put("since",since?:JSONObject.NULL).put("pageCursor",page?:JSONObject.NULL).put("limit",100)
    .put("scopes",JSONArray().put(JSONObject().put("scopeId",binding.scopeId).put("projection","sap.masters").put("params",JSONObject())))
   val response=pull(request)
   check(isCurrent()) {"Master authorization changed"}
   require(response.getInt("version")==2)
   val bundles=response.getJSONArray("bundles");require(bundles.length()==1)
   val bundle=bundles.getJSONObject(0)
   require(bundle.getString("scopeId")==binding.scopeId && bundle.getString("projection")=="sap.masters")
   serverTime=response.getLong("serverTime");require(serverTime>0)
   if(since==null) {
    val a=bundle.getJSONObject("data").getJSONArray("masters")
    for(i in 0 until a.length()) {
     val r=checked(a.getJSONObject(i));val id=r.getString("id")
     require(!rows.containsKey(id)) {"Repeated master in snapshot"}
     rows[id]=r;revisions[id]=r.getLong("revision")
    }
   }else {
    val a=bundle.getJSONArray("changes")
    for(i in 0 until a.length()) {
     val change=a.getJSONObject(i);val id=change.getString("id");val revision=change.getLong("revision")
     require(change.getString("entity")=="sap.master" && revision>0)
     if(revision<=(revisions[id]?:0L))continue
     when(change.getString("op")) {
      "tombstone"->rows.remove(id)
      "upsert"->{val r=checked(change.getJSONObject("value"));require(r.getString("id")==id);rows[id]=r}
      else->error("Unknown master change")
     }
     revisions[id]=revision
    }
   }
   require(rows.size<=MAX_ROWS && revisions.size<=MAX_ROWS) {"Master copy is too large; refresh a narrower selling scope"}
   if(!response.getBoolean("hasMore")) {cursor=response.getString("nextCursor").takeIf {it.isNotBlank()};require(cursor!=null);complete=true;break}
   page=response.getString("nextPageCursor");require(page.isNotBlank() && visited.add(page)) {"Master paging did not advance"}
  }
  check(complete && isCurrent()) {"Master snapshot is incomplete or authorization changed"}
  return JSONObject().put("binding",binding.fingerprint).put("cursor",cursor).put("receivedAt",serverTime)
   .put("masters",JSONArray(rows.values.toList())).put("revisions",JSONObject(revisions as Map<*,*>))
   .also {require(it.toString().toByteArray(Charsets.UTF_8).size<=MAX_BYTES) {"Master copy exceeds this phone's supported size"}}
 }
 private fun checked(r:JSONObject):JSONObject {
  require(r.getString("id").isNotBlank() && r.getLong("revision")>0 && r.getLong("version")>0)
  require(r.getString("source") in setOf("sap","sample") && r.getString("key").isNotBlank())
  require(r.getString("kind") in setOf("material","customer","outlet","condition","location","stock","ar"))
  require(r.getLong("effectiveFrom")>=0)
  if(r.has("effectiveTo") && !r.isNull("effectiveTo"))require(r.getLong("effectiveTo")>r.getLong("effectiveFrom"))
  require(r.getLong("receivedAt")>0 && !r.optBoolean("deleted"));r.getJSONObject("data")
  return JSONObject(r.toString())
 }
 /** Display only currently effective rows; never infer a selling price or credit approval here. */
 fun current(state:JSONObject,at:Long=System.currentTimeMillis()):List<JSONObject> {
  val a=state.getJSONArray("masters")
  return (0 until a.length()).map {a.getJSONObject(it)}.filter {
   it.getLong("effectiveFrom")<=at &&
    (!it.has("effectiveTo") || it.isNull("effectiveTo") || it.getLong("effectiveTo")>at)
  }
 }
}
