package com.sunpride.field.sync

import com.sunpride.field.storage.*
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Scoped domain forms share SQLCipher intent/outbox/ack tables, not a second delivery queue. */
object DomainOutbox {
    val authorizationLock=Any()
    private val denied=java.util.concurrent.ConcurrentHashMap<String,Boolean>()
    fun denied(key:String)=denied[key]==true
    fun deny(key:String){denied[key]=true;epoch.incrementAndGet()}
    fun renew(key:String){denied.remove(key)}
    private val epoch=java.util.concurrent.atomic.AtomicLong()
    fun begin()=epoch.incrementAndGet()
    fun ticket()=epoch.get()
    fun current(ticket:Long)=epoch.get()==ticket
    fun retire(){epoch.incrementAndGet()}
    val kinds=setOf("dsr.visit.checkIn","dsr.visit.activity","dsr.visit.checkOut","dsr.availability.record","jointcall.capture","collections.capture")
    private val flights=java.util.concurrent.ConcurrentHashMap<StoreScope,Mutex>()
    fun isDomain(kind:String)=kind in kinds
    fun intent(scope:StoreScope,kind:String,payload:JSONObject,aggregateId:String=UUID.randomUUID().toString(),dependsOn:List<String> = emptyList(),at:Long=System.currentTimeMillis()):IntentRow {
        require(isDomain(kind));val id=UUID.randomUUID().toString()
        val p=JSONObject(payload.toString()).put("deviceTime",at)
        return IntentRow(scope.account,scope.deviceId,scope.fingerprint,id,aggregateId,kind,JSONObject().put("clientRequestId",id).put("kind",kind).put("dependsOn",JSONArray(dependsOn)).put("payload",p).toString(),at)
    }
    /** Materialize once from durable parent ack; a retry never reserializes captured facts. */
    suspend fun materialize(store:RoomFieldStore,row:IntentRow):JSONObject? {
        store.localCache("local.domain.wire",row.requestId)?.json?.let{return JSONObject(it)}
        val op=JSONObject(row.serializedOperation);val p=op.getJSONObject("payload")
        if(p.has("localVisitRequestId")){
            val ack=store.ack(p.getString("localVisitRequestId"))?:return null
            p.remove("localVisitRequestId");p.put("visitId",ack.entityId)
        }
        if(p.has("localSessionRequestId")){
            val ack=store.ack(p.getString("localSessionRequestId"))?:return null
            p.remove("localSessionRequestId");p.put("sessionId",ack.entityId)
        }
        store.putLocalCache("local.domain.wire",row.requestId,op.toString(),row.createdAt,"")
        return op
    }
    suspend fun sync(store:RoomFieldStore,scope:StoreScope,scopeId:String,current:()->Boolean,post:(String,JSONObject)->JSONObject)=flights.computeIfAbsent(scope){Mutex()}.withLock {
        if(!current()||store.syncHealth()=="held_for_review")return@withLock
        for((row,_) in store.pending().filter{isDomain(it.first.kind)}.take(100)){
            if(!current()||store.syncHealth()=="held_for_review")return@withLock
            val original=JSONObject(row.serializedOperation);val deps=original.optJSONArray("dependsOn")?:JSONArray()
            if((0 until deps.length()).any{store.ack(deps.getString(it))==null})continue
            val prepared=materialize(store,row)?:continue
            val operation=V2Wire.operation(prepared)
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if(!current())return@withLock
            val response=post(V2Wire.PUSH,V2Wire.push(scope.deviceId,scopeId,JSONArray().put(operation)))
            kotlinx.coroutines.currentCoroutineContext().ensureActive()
            if(!current()||store.syncHealth()=="held_for_review")return@withLock
            require(response.getInt("version")==2)
            val results=response.getJSONArray("results");require(results.length()==1)
            val result=results.getJSONObject(0);require(result.getString("clientOpId")==row.requestId&&result.getString("opType")==row.kind)
            if(result.optBoolean("retryable"))return@withLock
            when(result.getString("status")){
                "applied","duplicate"->{val ack=result.getJSONObject("ack");store.recordAck(row.requestId,ack.getString("entityId"),ack.getJSONArray("eventIds").toString(),ack.getLong("serverTime"))}
                "rejected","conflict","unsupported"->{val code=result.optString("code","review_required");store.recordRejection(row.requestId,code);if(code in setOf("out_of_scope","scope_changed","device_revoked","unauthorized")){store.holdForReview();return@withLock}}
                else->return@withLock
            }
        }
    }
}
