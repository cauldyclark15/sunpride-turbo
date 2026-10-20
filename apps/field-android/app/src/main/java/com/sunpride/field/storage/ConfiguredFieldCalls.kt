package com.sunpride.field.storage

import com.sunpride.callflow.CallFlowEngine
import org.json.JSONObject

/** F-006: called inside the existing intent+outbox transaction. The start freezes its downloaded definition. */
object ConfiguredFieldCalls {
    // Legacy opaque persistence rows have no configuration. Malformed JSON objects still fail closed.
    private fun cachedConfig(raw: String): JSONObject? = if(raw.trimStart().startsWith('{')) JSONObject(raw).optJSONObject("callFlow") else null
    fun payload(row: IntentRow) = JSONObject(row.serializedOperation).getJSONObject("payload")
    fun config(rows: List<Pair<IntentRow,String>>, clientVisitId: String): JSONObject? = rows.firstOrNull {
        it.first.clientVisitId == clientVisitId && it.first.kind == "visit.checkIn" && it.second in setOf("pending","sending","done")
    }?.first?.let { JSONObject(it.serializedOperation).optJSONObject("payload") }?.optJSONObject("callFlowSnapshot")
    fun adapter(row: IntentRow): String? = if (row.kind == RetailCaptureQueue.KIND) payload(row).getString("kind") else CallFlowEngine.fieldAdapter(if (row.kind == "visit.activity") payload(row).getJSONObject("activity").getString("kind") else row.kind)
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
        val p = JSONObject(intent.serializedOperation).optJSONObject("payload") ?: return intent
        val used = rows.filter { it.second in setOf("pending","sending","done") }.mapNotNull { JSONObject(it.first.serializedOperation).optJSONObject("payload")?.optString("geofenceApprovalId") }.toSet()
        fun prepared() = intent.copy(serializedOperation = JSONObject(intent.serializedOperation).put("payload",p).toString())
        if (intent.kind == "visit.checkIn") {
            val config = store.outlets().firstOrNull { it.id == p.getString("outletId") }?.let { cachedConfig(it.json) } ?: return intent
            val approval = CallFlowEngine.approval(config,"geofence_start",p.getLong("deviceTime"),used)
            if(CallFlowEngine.location(config,p.optJSONObject("location"),p.getLong("deviceTime"),approval != null))
                approval?.let { p.put("geofenceApprovalId",it) }
            p.put("flowDefinitionId",config.getJSONObject("definition").getString("id")).put("callFlowSnapshot",config)
            return prepared()
        }
        val config = config(rows,intent.clientVisitId) ?: return intent
        val done = done(config,rows,intent.clientVisitId).toMutableSet()
        if (store.visitPhotos(intent.clientVisitId).any { it.state in setOf("pending","uploaded") }) CallFlowEngine.keyFor(config,"evidence")?.let(done::add)
        val own = rows.filter { it.first.clientVisitId == intent.clientVisitId && it.second in setOf("pending","sending","done") }
        val hasOrder = own.any { adapter(it.first) == "order_build" }
        if (config.getJSONObject("definition").optString("channelProfile") == "merchandiser") {
            if(adapter(intent) == "order_build") error("This is an execution-only merchandising call")
            if(intent.kind == "visit.activity" && adapter(intent) == "promotion") error("Use the campaign checklist for this call")
        }
        if (intent.kind == "visit.checkOut") {
            val start = own.first { it.first.kind == "visit.checkIn" }.first.let(::payload)
            val renewed = store.outlets().firstOrNull { it.id == start.getString("outletId") }?.let { cachedConfig(it.json) }
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
