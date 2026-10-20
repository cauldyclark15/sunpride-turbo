package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.callflow.CallFlowEngine
import com.sunpride.callflow.CallFlowRefused
import org.json.JSONObject
import java.util.UUID

/** F-006 F-107: existing SQLCipher outbox is the local event journal; no second queue or stock writer. */
class VanCallStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId
    private val usable = setOf("pending","sending","done")
    private fun payload(row: OutboxRow) = JSONObject(row.operationJson).getJSONObject("payload")
    private suspend fun trip() = checkNotNull(dao.trip(s,d)) { "No trip assigned" }
    suspend fun deliveries(): List<JSONObject> {
        val journal=rows()
        return CallFlowEngine.objects(JSONObject(trip().json).optJSONArray("_deliveries") ?: org.json.JSONArray()).map { original ->
            JSONObject(original.toString()).apply {
                val own=journal.filter { it.kind in setOf("delivery.confirm","delivery.timing") && payload(it).getString("dropId")==getString("dropId") }
                if(getString("status")=="scheduled" && own.any { it.kind=="delivery.confirm" }) put("status","saved_on_phone")
                own.filter { it.kind=="delivery.timing" }.forEach { row ->
                    val event=payload(row);val key=when(event.getString("stage")) { "arrival"->"arrivedAt";"unloading"->"unloadingAt";else->"departedAt" }
                    put(key,event.getLong("deviceTime"))
                }
            }
        }
    }
    suspend fun config(outletId: String): JSONObject? = JSONObject(trip().json).optJSONObject("_callFlows")?.optJSONObject(outletId)
    private suspend fun rows(): List<OutboxRow> {
        val tripId=trip().tripId
        return dao.outboxRows(s,d).filter { it.tripId == tripId && it.status in usable }.sortedWith(compareBy({it.createdAt},{it.clientRequestId}))
    }
    suspend fun current(): JSONObject? {
        val rows = rows()
        val closed = rows.filter { it.kind == "call.close" }.map { payload(it).getString("clientCallId") }.toSet()
        return rows.lastOrNull { it.kind == "call.start" && payload(it).getString("clientCallId") !in closed }?.let(::payload)
    }
    private suspend fun done(start: JSONObject): MutableSet<String> {
        val config = start.getJSONObject("callFlowSnapshot"); val id = start.getString("clientCallId")
        val done = mutableSetOf<String>()
        rows().filter { payload(it).optString("clientCallId") == id }.forEach { row ->
            val adapters = when(row.kind) {
                "call.start" -> listOf("check_in"); "call.step" -> listOf(payload(row).getString("adapter"))
                "sale.record" -> listOf("order_build","discount","invoice","payment")
                "delivery.confirm" -> listOf("delivery_confirm")
                "return.record" -> listOf("return_pickup"); "call.close" -> listOf("check_out"); else -> emptyList()
            }
            adapters.mapNotNull { CallFlowEngine.keyFor(config,it) }.forEach(done::add)
        }
        return done
    }
    private suspend fun hasOrder(start: JSONObject): Boolean {
        val voided = dao.salevoidRows(s,d).map { it.saleId }.toSet()
        val saleIds = rows().filter { it.kind == "sale.record" && payload(it).optString("clientCallId") == start.getString("clientCallId") }
            .map { payload(it).getString("saleId") }.toSet() - voided
        return dao.saleRows(s,d).any { it.saleId in saleIds }
    }
    /** Called inside the existing checkout/return transaction, after validation and before outbox insertion. */
    suspend fun bindAdapter(payload: JSONObject, outletId: String, adapters: List<String>) {
        if (config(outletId) == null) return
        val start = current() ?: throw CallFlowRefused("Check in to this store before selling or recording returns.")
        if (start.getString("outletId") != outletId) throw CallFlowRefused("Finish the open call before changing store.")
        val config = start.getJSONObject("callFlowSnapshot"); val done = done(start)
        adapters.forEach { adapter -> CallFlowEngine.keyFor(config,adapter)?.let { key ->
            CallFlowEngine.advance(config,done,adapter,adapters.contains("order_build") || hasOrder(start)); done.add(key)
        } }
        payload.put("clientCallId",start.getString("clientCallId"))
    }
    suspend fun record(kind: String, outletId: String, fix: JSONObject?, options: JSONObject): String = db.withTransaction {
        check(store.canSync()) { "Sync to verify access first" }
        val trip = trip(); check(trip.status == "active" || rows().any { it.kind == "trip.start" }) { "Start the trip first" }
        check(dao.tripClose(s,d,trip.tripId) == null && dao.stockReconciliation(s,d,trip.tripId) == null) { "Trip is closing" }
        val at = if(kind == "delivery.confirm") options.getLong("deviceTime") else store.now()
        val payload = JSONObject().put("tripId",trip.tripId).put("outletId",outletId).put("deviceTime",at)
        options.keys().asSequence().forEach { key -> if (key in setOf("sequenceReason","unplannedReason","zeroSaleReason","shortCallReason","adapter","observation","note","geofenceApprovalId","photoSha256","dropId","signature","receiverName","lines","watermark","stage","reason")) payload.put(key,options.get(key)) }
        when(kind) {
            "call.start" -> {
                if (current() != null) throw CallFlowRefused("Finish the open call first.")
                val config = config(outletId) ?: throw CallFlowRefused("Sync a published call flow for this store.")
                val approval = CallFlowEngine.approval(config,"geofence_start",at,rows().map { payload(it).optString("geofenceApprovalId") }.toSet())
                if(CallFlowEngine.location(config,fix,at,approval != null))
                    approval?.let { payload.put("geofenceApprovalId",it) }
                val customers = dao.customerRows(s,d)
                val customer = customers.single { it.outletId == outletId }
                val closed = rows().filter { it.kind == "call.close" }.map { payload(it).getString("outletId") }.toSet() +
                    (JSONObject(trip.json).optJSONArray("_serverCalls")?.let(CallFlowEngine::objects)?.filter { it.getString("state") == "closed" }?.map { it.getString("outletId") } ?: emptyList())
                if (customer.source != "route" && payload.optString("unplannedReason").isBlank()) throw CallFlowRefused("Give a reason for this unplanned store.")
                if (customer.source == "route" && customers.any { it.source == "route" && (it.sequence ?: Int.MAX_VALUE) < (customer.sequence ?: Int.MAX_VALUE) && it.outletId !in closed } && payload.optString("sequenceReason").isBlank())
                    throw CallFlowRefused("An earlier planned store is still open. Give a sequence deviation reason.")
                payload.put("clientCallId",UUID.randomUUID().toString()).put("flowDefinitionId",config.getJSONObject("definition").getString("id"))
                    .put("callFlowSnapshot",config).put("location",fix)
            }
            "call.step","call.close","delivery.confirm","delivery.timing" -> {
                val start = current() ?: throw CallFlowRefused("Check in first.")
                if (start.getString("outletId") != outletId) throw CallFlowRefused("This is not the open store.")
                val config = start.getJSONObject("callFlowSnapshot")
                payload.put("clientCallId",start.getString("clientCallId"))
                if(kind == "delivery.confirm") {
                    val drop=deliveries().single { it.getString("dropId")==payload.getString("dropId") && it.getString("outletId")==outletId }
                    check(drop.getString("status")=="scheduled") { "Delivery is already saved or is not assigned." }
                    payload.put("location",fix)
                    CallFlowEngine.location(config,fix,at)
                    checkNotNull(store.evidence).read(payload.getString("photoSha256"),96_000)
                    com.sunpride.van.delivery.DeliveryProofRules.validate(drop,payload)
                    CallFlowEngine.advance(config,done(start),"delivery_confirm",hasOrder(start))
                } else if(kind == "delivery.timing") {
                    payload.put("location",fix)
                    val drop=deliveries().single { it.getString("dropId")==payload.getString("dropId") && it.getString("outletId")==outletId }
                    com.sunpride.van.delivery.DeliveryProofRules.validateTiming(drop,payload.getString("stage"),at,payload.optString("reason"))
                } else if (kind == "call.close") {
                    val approval = CallFlowEngine.approval(config(outletId) ?: config,"geofence_end",at,rows().map { payload(it).optString("geofenceApprovalId") }.toSet(),config.getJSONObject("policy").optString("id"))
                    if(CallFlowEngine.location(config,fix,at,approval != null))
                        approval?.let { payload.put("geofenceApprovalId",it) }
                    payload.put("location",fix)
                    CallFlowEngine.close(config,done(start),hasOrder(start),start.getLong("deviceTime"),payload)
                } else {
                    val adapter = payload.getString("adapter")
                    require(adapter in setOf("stock_check","note","evidence"))
                    if (adapter == "evidence") {
                        val sha=payload.getString("photoSha256")
                        require(sha.matches(Regex("[0-9a-f]{64}")))
                        checkNotNull(store.evidence).read(sha,96_000) // actual saved capture, not a done checkbox
                    }
                    if (adapter != "evidence" && payload.optString(if (adapter == "note") "note" else "observation").isBlank()) throw CallFlowRefused("Record the stock observation or note.")
                    CallFlowEngine.advance(config,done(start),adapter,hasOrder(start))
                }
            }
            else -> error("Unknown call action")
        }
        val id = UUID.randomUUID().toString()
        val previous = rows().lastOrNull { payload(it).optString("clientCallId") == payload.getString("clientCallId") }
        val operation = JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",payload)
        previous?.let { operation.put("dependsOn",org.json.JSONArray().put(it.clientRequestId)) }
        val created = maxOf(at,Math.addExact(dao.latestCreatedAt(s,d) ?: 0L,1))
        dao.insertOutbox(OutboxRow(s,d,id,trip.tripId,kind,operation.toString(),created))
        id
    }
}
