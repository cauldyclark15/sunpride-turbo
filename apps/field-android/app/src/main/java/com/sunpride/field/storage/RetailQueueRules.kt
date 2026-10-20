package com.sunpride.field.storage

import com.sunpride.retail.RetailAvailability
import com.sunpride.retail.RetailCall
import com.sunpride.retail.ShelfAnswer
import org.json.JSONObject

/** F-212 CALLFLOW seam: the existing store transaction enforces the configured availability step. */
object RetailQueueRules {
    suspend fun call(store: FieldStore,outletId: String): RetailCall? = store.outlets().firstOrNull { it.id==outletId }
        ?.let {JSONObject(it.json).optJSONObject("availability") }?.let(RetailAvailability::decode)
    fun saved(clientVisitId: String,rows: List<Pair<IntentRow,String>>): Boolean = rows.any { (r,state)->
        r.clientVisitId==clientVisitId && r.kind=="availability.record" && state in setOf("pending","sending","done") &&
            JSONObject(r.serializedOperation).getJSONObject("payload").optBoolean("complete") }
    suspend fun validate(store: FieldStore,intent: IntentRow) {
        if(intent.kind !in setOf("availability.record","availability.proposal","visit.checkOut"))return
        val rows=store.history().map {it.first to it.second.state}
        val start=rows.firstOrNull {it.first.clientVisitId==intent.clientVisitId && it.first.kind=="visit.checkIn" && it.second in setOf("pending","sending","done")}
            ?: error("Start this call before recording availability")
        val outlet=JSONObject(start.first.serializedOperation).getJSONObject("payload").getString("outletId")
        val call=call(store,outlet)
        if(intent.kind=="visit.checkOut") {
            check(call==null||saved(intent.clientVisitId,rows)) {"Check every MSL line before ending the call"};return
        }
        check(!VisitCallRules.closed(rows.filter {it.first.clientVisitId==intent.clientVisitId})) {"This call has ended"}
        val p=JSONObject(intent.serializedOperation).getJSONObject("payload")
        check(p.getString("visitId")=="@checkin:${start.first.requestId}")
        if(intent.kind=="availability.record") {
            checkNotNull(call) {"No downloaded MSL"};check(p.getString("snapshotId")==call.snapshotId)
            val a=p.getJSONArray("lines")
            val answers=(0 until a.length()).map {i->a.getJSONObject(i).let {ShelfAnswer(it.getString("productId"),it.getString("state"),it.getString("method"),if(it.isNull("shelfBase"))null else it.getLong("shelfBase"),if(it.isNull("backroomBase"))null else it.getLong("backroomBase"))}}
            RetailAvailability.validate(call,answers)
        }
    }
}
