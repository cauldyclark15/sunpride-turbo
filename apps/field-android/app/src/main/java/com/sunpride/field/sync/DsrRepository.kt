package com.sunpride.field.sync

import android.content.Context
import android.content.SharedPreferences
import com.sunpride.field.storage.*
import com.sunpride.field.ui.TodayData
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject

/** F-407 complete signed partner snapshot on the existing encrypted field partition. */
class DsrRepository(private val context:Context,private val prefs:SharedPreferences,private val origin:String,
    private val key:String,private val device:String,private val current:()->Boolean,
    private val get:(String)->JSONObject,private val post:(String,JSONObject)->JSONObject){
    private fun savedScope():StoreScope? {
        val a=prefs.getString("$key.subject",null)?:return null
        val s=prefs.getString("$key.scope",null)?:return null
        if(prefs.getString("$key.device",null)!=device)return null
        return StoreScope(a,device,s)
    }
    fun hold(){if(current())runBlocking{EncryptedFieldDatabase.holdExisting(context)}}
    fun load(me:JSONObject?):TodayData {
        var warning:String?=null
        if(me!=null){
            require(me.getJSONObject("profile").getString("role")=="distributor")
            val profile=me.getJSONObject("profile");val scopeMeta=me.getJSONObject("scope")
            require(profile.getBoolean("active")&&me.getJSONObject("device").getString("id")==device)
            val scope=StoreScope("v2:$origin|${profile.getString("subject")}",device,scopeMeta.getString("fingerprint"))
            val identity=get("/api/v1/distributors/self-field")
            val params=JSONObject().put("distributorId",identity.getString("id"))
            val response=post(V2Wire.PULL,V2Wire.pull(device,scopeMeta.getString("id"),"distributor.bundle",params))
            val b=V2Wire.bundle(response,me,"distributor.bundle",params)
            require(!response.getBoolean("hasMore")&&b.getBoolean("complete")&&b.getString("mode")=="snapshot")
            val data=b.getJSONObject("data")
            require(data.getString("profileId")==profile.getString("id")&&data.getString("distributorId")==identity.getString("id"))
            val expires=minOf(b.getJSONObject("authorization").getLong("expiresAt"),b.getJSONObject("offlineLease").getLong("expiresAt"))
            require(expires>response.getLong("serverTime")&&current())
            if(savedScope()!=null&&savedScope()!=scope)hold()
            val store=EncryptedFieldDatabase.store(context,scope)
            try{synchronized(DomainOutbox.authorizationLock){runBlocking{
                check(current())
                val rows=data.getJSONArray("outlets")
                val outlets=(0 until rows.length()).map{val o=rows.getJSONObject(it);SnapshotItem(o.getString("id"),o.toString())}
                store.retailTransaction{
                    check(current())
                    val generation=store.stage(ScopedSnapshot(profile.toString(),null,emptyList(),outlets,emptyList(),emptyList()))
                    store.putLocalCache("local.dsr","bundle",data.toString(),response.getLong("serverTime"),"")
                    store.swap(generation,response.getString("nextCursor"),expires,expires,releaseHeld=true)
                    check(current())
                }
                check(current())
                check(prefs.edit().putString("$key.subject",scope.account).putString("$key.scope",scope.fingerprint).putString("$key.device",device)
                    .putString("$key.scopeId",scopeMeta.getString("id")).putBoolean("$key.partner",true).putBoolean("$key.domainDenied",false).commit())
                DomainOutbox.renew(key)
            }}
            runBlocking{
                DomainOutbox.sync(store,scope,scopeMeta.getString("id"),current,post)
                if(store.syncHealth()!="held_for_review")store.markSyncSuccess(System.currentTimeMillis())
            }}finally{store.close()}
        }
        val scope=savedScope()?:return TodayData(partnerMode=true,warning="Sync your distributor assignment to begin.")
        val store=EncryptedFieldDatabase.store(context,scope)
        return try{runBlocking{
            val allowed=current()&&!DomainOutbox.denied(key)&&!prefs.getBoolean("$key.domainDenied",false)&&store.isLeaseValid(System.currentTimeMillis())
            val data=if(allowed)store.localCache("local.dsr","bundle")?.json?.let(::JSONObject)else null
            val history=store.history().filter{DomainOutbox.isDomain(it.first.kind)}
            data?.put("localOperations",JSONArray().apply{for((row,outbox) in history){put(JSONObject().put("requestId",row.requestId).put("kind",row.kind).put("state",outbox.state).put("aggregateId",row.clientVisitId).put("payload",JSONObject(row.serializedOperation).getJSONObject("payload")).put("ackId",store.ack(row.requestId)?.entityId?:JSONObject.NULL))}})
            val status=store.status()
            TodayData(lastSynced=status.lastSuccess,stale=me==null,warning=warning?:if(!allowed)"Assignment held or expired. Connect before recording."else null,
                syncStatus=status,queuedCount=status.queued+status.sending,reviewCount=status.review+status.held,partnerMode=true,partner=data)
        }}finally{store.close()}
    }
}
