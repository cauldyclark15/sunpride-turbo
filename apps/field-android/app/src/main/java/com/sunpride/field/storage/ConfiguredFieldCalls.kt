package com.sunpride.field.storage

import com.sunpride.callflow.CallFlowEngine
import org.json.JSONObject

/** F-006: called inside the existing intent+outbox transaction. The start freezes its downloaded definition. */
object ConfiguredFieldCalls {
    fun payload(row: IntentRow) = JSONObject(row.serializedOperation).getJSONObject("payload")
    private fun optionalPayload(row: IntentRow): JSONObject? = if(row.serializedOperation.trimStart().startsWith("{")) JSONObject(row.serializedOperation).optJSONObject("payload") else null
    private fun downloaded(json: String): JSONObject? {
        if(!json.trimStart().startsWith("{")) return null // Legacy storage fixtures/cache rows are opaque, not an enabled flow.
        val row=JSONObject(json)
        return if(row.has("callFlow") && !row.isNull("callFlow")) row.getJSONObject("callFlow") else null
    }
    fun config(rows: List<Pair<IntentRow,String>>, clientVisitId: String): JSONObject? = rows.firstOrNull {
        it.first.clientVisitId == clientVisitId && it.first.kind == "visit.checkIn" && it.second in setOf("pending","sending","done")
    }?.first?.let(::optionalPayload)?.let { if(it.has("callFlowSnapshot") && !it.isNull("callFlowSnapshot")) it.getJSONObject("callFlowSnapshot") else null }
    fun adapter(row: IntentRow): String? = CallFlowEngine.fieldAdapter(if (row.kind == "visit.activity") payload(row).getJSONObject("activity").getString("kind") else row.kind)
    fun done(config: JSONObject, rows: List<Pair<IntentRow,String>>, clientVisitId: String): Set<String> = rows.filter {
        it.first.clientVisitId == clientVisitId && it.second in setOf("pending","sending","done")
    }.mapNotNull { adapter(it.first)?.let { a -> CallFlowEngine.keyFor(config,a) } }.toSet()
    suspend fun validatePhoto(store: FieldStore, clientVisitId: String) {
        val rows=store.history().map { it.first to it.second.state }
        val config=config(rows,clientVisitId) ?: return
        if (CallFlowEngine.keyFor(config,"evidence") != null)
            CallFlowEngine.advance(config,done(config,rows,clientVisitId),"evidence",rows.any { it.first.clientVisitId == clientVisitId && adapter(it.first) == "order_build" && it.second in setOf("pending","sending","done") })
    }
    /** Only configured REQUIRED media delays delivery of End; old outboxes and optional photos are unchanged. */
    suspend fun waitingForEvidence(store: FieldStore, intent: IntentRow): Boolean {
        if (intent.kind != "visit.checkOut") return false
        val rows=store.history().map { it.first to it.second.state }
        val config=config(rows,intent.clientVisitId) ?: return false
        val order=rows.any { it.first.clientVisitId == intent.clientVisitId && adapter(it.first) == "order_build" && it.second in setOf("pending","sending","done") }
        val required=CallFlowEngine.objects(config.getJSONObject("definition").getJSONArray("steps"))
            .any { it.getString("adapter") == "evidence" && it.getBoolean("required") && CallFlowEngine.applies(it,order) }
        return required && store.visitPhotos(intent.clientVisitId).none { it.state == "uploaded" }
    }
    suspend fun prepare(store: FieldStore, intent: IntentRow): IntentRow {
        val rows = store.history().map { it.first to it.second.state }
        val config = if(intent.kind == "visit.checkIn") {
            val available=store.outlets().mapNotNull { row -> downloaded(row.json)?.let { row.id to it } }.toMap()
            if(available.isEmpty()) return intent
            available[optionalPayload(intent)?.optString("outletId")] ?: return intent
        } else config(rows,intent.clientVisitId) ?: return intent
        val p = payload(intent)
        val used = rows.filter { it.second in setOf("pending","sending","done") }.mapNotNull { optionalPayload(it.first)?.optString("geofenceApprovalId") }.toSet()
        fun prepared() = intent.copy(serializedOperation = JSONObject(intent.serializedOperation).put("payload",p).toString())
        if (intent.kind == "visit.checkIn") {
            val approval = CallFlowEngine.approval(config,"geofence_start",p.getLong("deviceTime"),used)
            if(CallFlowEngine.location(config,p.optJSONObject("location"),p.getLong("deviceTime"),approval != null))
                approval?.let { p.put("geofenceApprovalId",it) }
            p.put("flowDefinitionId",config.getJSONObject("definition").getString("id")).put("callFlowSnapshot",config)
            return prepared()
        }

        val done = done(config,rows,intent.clientVisitId).toMutableSet()
        if (store.visitPhotos(intent.clientVisitId).any { it.state in setOf("pending","uploaded") }) CallFlowEngine.keyFor(config,"evidence")?.let(done::add)
        val own = rows.filter { it.first.clientVisitId == intent.clientVisitId && it.second in setOf("pending","sending","done") }
        val hasOrder = own.any { adapter(it.first) == "order_build" }
        if (intent.kind == "visit.checkOut") {
            val start = own.first { it.first.kind == "visit.checkIn" }.first.let(::payload)
            val renewed = store.outlets().firstOrNull { it.id == start.getString("outletId") }?.let { downloaded(it.json) }
            val approval = CallFlowEngine.approval(renewed ?: config,"geofence_end",p.getLong("deviceTime"),used,config.getJSONObject("policy").optString("id"))
            if(CallFlowEngine.location(config,p.optJSONObject("location"),p.getLong("deviceTime"),approval != null))
                approval?.let { p.put("geofenceApprovalId",it) }
            CallFlowEngine.close(config,done,hasOrder,start.getLong("deviceTime"),p)
        } else adapter(intent)?.let { a ->
            if (CallFlowEngine.keyFor(config,a) != null) CallFlowEngine.advance(config,done,a,hasOrder || a == "order_build")
        }
        return prepared()
    }
}
