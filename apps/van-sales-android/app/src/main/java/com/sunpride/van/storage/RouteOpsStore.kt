package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** F-114/F-115/F-116/F-121 route facts use the existing encrypted Room outbox, not another sync queue. */
class RouteOpsStore(private val store: RoomVanStore) {
    private val dao = store.db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId
    suspend fun snapshot(): JSONObject? = dao.trip(s,d)?.let { JSONObject(it.json).optJSONObject("_vanOps") }
    suspend fun version(): Int = dao.meta(s,d)?.policyJson?.let { JSONObject(it).optInt("operationsVersion",0) } ?: 0
    suspend fun prepare(payload: JSONObject): JSONObject = payload.apply { if (version() == 1) {
        put("settlementVersion",1)
        put("deviceTime",maxOf(store.now(),Math.addExact(dao.latestCreatedAt(s,d)?:0,1)))
    } }
    private suspend fun policy(kind: String): JSONObject = checkNotNull(snapshot()).getJSONObject("policies").getJSONObject(kind)
    suspend fun observations(): List<JSONObject> {
        val t = dao.trip(s,d) ?: return emptyList()
        val remote = snapshot()?.optJSONArray("observations")?.let(VanBootstrapCodec::objects) ?: emptyList()
        val local = dao.outboxRows(s,d).filter { it.tripId==t.tripId && it.kind in KINDS && it.status in setOf("pending","sending","done") }.map { row ->
            val p=JSONObject(row.operationJson).getJSONObject("payload")
            JSONObject().put("id",p.getString("observationId")).put("kind",row.kind.substringBefore('.'))
                .put("capturedAt",p.getLong("deviceTime")).put("facts",p).put("localStatus",row.status)
        }
        return (local+remote).associateBy { it.getString("id") }.values.sortedBy { o->o.opt("capturedAt").let { if(it is Number) it.toLong() else java.time.Instant.parse(it.toString()).toEpochMilli() } }
    }
    private suspend fun append(kind: String,payload: JSONObject): String {
        check(store.canSync()) { "Phone access is paused" }
        val t=checkNotNull(dao.trip(s,d))
        check(version()==1) { "Download a route configured for cold chain and offline settlement" }
        check(dao.tripClose(s,d,t.tripId)==null) { "Trip already locally completed" }
        val id=UUID.randomUUID().toString()
        val at=maxOf(store.now(),Math.addExact(dao.latestCreatedAt(s,d)?:0,1))
        payload.put("tripId",t.tripId).put("deviceTime",at).put("settlementVersion",1)
        if (!payload.has("observationId")) payload.put("observationId",UUID.randomUUID().toString())
        val op=JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",payload).toString()
        dao.insertOutbox(OutboxRow(s,d,id,t.tripId,kind,op,at))
        return id
    }
    suspend fun openStop(): JSONObject? {
        val events=observations().filter {it.getString("kind")=="stop"}
        val finished=events.filter {it.getJSONObject("facts").getString("phase")=="departure"}.map {it.getJSONObject("facts").getString("stopId")}.toSet()
        return events.firstOrNull {it.getJSONObject("facts").getString("phase")=="arrival" && it.getJSONObject("facts").getString("stopId") !in finished}
    }
    suspend fun stop(outletId: String,phase: String): String = store.db.withTransaction {
        require(phase in setOf("arrival","departure") && dao.customerRows(s,d).any {it.outletId==outletId})
        val open=openStop()
        if(phase=="arrival") check(open==null) {"Finish the current stop first"}
        else check(open!=null && open.getJSONObject("facts").optString("outletId",open.optString("outletId"))==outletId) {"Depart from the current store"}
        val stopId=if(phase=="arrival") UUID.randomUUID().toString() else checkNotNull(open).getJSONObject("facts").getString("stopId")
        append("stop.record",JSONObject().put("stopId",stopId).put("phase",phase).put("outletId",outletId))
    }
    suspend fun temperature(deciC: Int,checkpoint: String,outletId: String?=null,note: String?=null): String = store.db.withTransaction {
        require(deciC in -1000..600 && checkpoint in setOf("load_out","interval","delivery"))
        val trip=checkNotNull(dao.trip(s,d))
        val onRoad=trip.status in setOf("active","reconciling","review_required") || dao.outboxRows(s,d).any {it.tripId==trip.tripId && it.kind=="trip.start" && it.status in setOf("pending","sending","done")}
        require((checkpoint=="load_out")!=onRoad) {"Choose load-out before departure, or delivery / interval on the route"}
        require((checkpoint=="delivery")==!outletId.isNullOrBlank())
        if (outletId!=null) require(dao.customerRows(s,d).any { it.outletId==outletId })
        val bands=VanBootstrapCodec.objects(policy("cold_chain").getJSONArray("bands"))
        val products=dao.productRows(s,d).map { it.productId }
        val applicable=if(products.isEmpty()) bands.filter {it.isNull("productId")} else products.map { product-> bands.firstOrNull { it.optString("productId")==product } ?: checkNotNull(bands.firstOrNull { it.isNull("productId") }) }
        check(applicable.isNotEmpty()) {"Download an approved van storage band"}
        val excursion=applicable.any { deciC<it.getInt("minDeciC") || deciC>it.getInt("maxDeciC") }
        val previous=observations().lastOrNull {it.getString("kind")=="temperature"}
        val captured=previous?.opt("capturedAt")?.let {if(it is Number) it.toLong() else java.time.Instant.parse(it.toString()).toEpochMilli()}
        val at=maxOf(store.now(),Math.addExact(dao.latestCreatedAt(s,d)?:0,1))
        val gap=captured?.let {(at-it).coerceAtLeast(0L)}?:0L
        append("temperature.record",JSONObject().put("deciC",deciC).put("checkpoint",checkpoint).put("method","manual").put("excursion",excursion)
            .put("lateFromPrior",gap>policy("cold_chain").getLong("intervalMinutes")*60_000).put("gapMinutes",gap/60_000)
            .apply { outletId?.let { put("outletId",it) }; note?.let { put("note",it) } })
    }
    /** F-115 rechecked inside Start/Checkout's transaction, before any stock or number is consumed. */
    suspend fun requireTemperature(checkpoint: String,outletId: String?=null) {
        if (version()!=1) return
        if(checkpoint!="interval") check(observations().none {o->o.getString("kind")=="temperature" && o.getJSONObject("facts").let {it.optBoolean("excursion") || it.optBoolean("lateFromPrior")} && o.optString("decision")!="released"}) {"Office quality review is required before departure or another sale"}
        val last=observations().filter { it.getString("kind")=="temperature" }.lastOrNull()
            ?: error("Record the cold-chain temperature before continuing")
        val facts=last.getJSONObject("facts")
        val captured=last.opt("capturedAt").let { if(it is Number) it.toLong() else java.time.Instant.parse(checkNotNull(it).toString()).toEpochMilli() }
        check(store.now()-captured<=policy("cold_chain").getLong("intervalMinutes")*60_000) { "A cold-chain temperature reading is due" }
        check(checkpoint=="interval" || facts.getString("checkpoint")==checkpoint && (outletId==null || facts.optString("outletId",last.optString("outletId"))==outletId)) { "Record a temperature at this checkpoint" }
    }
    suspend fun returnable(outletId: String?,typeCode: String,action: String,quantity: Long): String = store.db.withTransaction {
        require(quantity>=0 && (quantity>0 || action=="count") && action in setOf("issue","receive","count"))
        require(outletId==null && action=="count" || dao.customerRows(s,d).any { it.outletId==outletId })
        require(VanBootstrapCodec.objects(policy("returnables").getJSONArray("items")).any { it.getString("code")==typeCode })
        if(action=="issue") require(containerPosition().firstOrNull {it.getString("typeCode")==typeCode}?.optString("quantity")?.toLongOrNull()?.let {it>=quantity}==true) {"Count sufficient van containers first"}
        append("returnable.record",JSONObject().put("outletId",outletId).put("typeCode",typeCode).put("action",action).put("quantity",quantity.toString()))
    }
    suspend fun containerPosition(): List<JSONObject> {
        val amounts=snapshot()?.optJSONArray("vanContainers")?.let(VanBootstrapCodec::objects)?.associateBy {it.getString("typeCode")}?.toMutableMap()?:mutableMapOf()
        VanBootstrapCodec.objects(policy("returnables").getJSONArray("items")).forEach {item->amounts.getOrPut(item.getString("code")) {JSONObject().put("typeCode",item.getString("code")).put("label",item.getString("label")).put("quantity",JSONObject.NULL)}}
        val baselineAt=dao.meta(s,d)?.lastBootstrapTime?:0
        val acks=dao.ackRows(s,d).associateBy {it.clientRequestId}
        dao.outboxRows(s,d).filter {it.kind=="returnable.record" && it.status !in setOf("rejected","conflict") && !com.sunpride.van.ledger.StockProjection.reflected(acks[it.clientRequestId]?.serverTime,baselineAt)}.sortedBy {it.createdAt}.forEach {op->
            val p=JSONObject(op.operationJson).getJSONObject("payload")
            val code=p.getString("typeCode")
            val r=amounts.getOrPut(code) {JSONObject().put("typeCode",code).put("quantity",JSONObject.NULL)}
            if(p.getString("action")=="count" && p.isNull("outletId")) r.put("quantity",p.getString("quantity"))
            if(!r.isNull("quantity") && !p.isNull("outletId") && p.getString("action")!="count") r.put("quantity",Math.addExact(r.getString("quantity").toLong(),p.getString("quantity").toLong()*(if(p.getString("action")=="receive") 1L else -1L)).toString())
        }
        return amounts.values.toList()
    }
    suspend fun reloadRequest(productId: String,quantity: Long,note: String): String = store.db.withTransaction {
        require(quantity>0 && note.isNotBlank() && note.length<=300)
        require(dao.productRows(s,d).any { it.productId==productId })
        append("reload.request",JSONObject().put("lines",JSONArray().put(JSONObject().put("productId",productId).put("quantityBase",quantity.toString()))).put("note",note))
    }
    /** F-116 exact final count, retained locally; warehouse receipt never inferred from this capture. */
    suspend fun unload(): String = store.db.withTransaction {
        requireTemperature("interval")
        val t=checkNotNull(dao.trip(s,d)); check(dao.stockReconciliation(s,d,t.tripId)!=null) { "Count the final stock first" }
        check(observations().none { it.getString("kind")=="unload" }) { "Unload is already saved" }
        val products=dao.productRows(s,d).associateBy { it.productId }
        val batches=com.sunpride.van.ledger.BatchLedger(store).positions().filter {it.status in setOf("available","damaged")}
        val lines=JSONArray()
        store.stock().forEach { stock ->
            for ((status,quantity) in listOf("available" to stock.availableBase,"damaged" to stock.damagedBase)) {
                val own=batches.filter {it.productId==stock.productId && it.status==status}
                val template=JSONObject().put("productId",stock.productId).put("status",status).put("partition",if(status=="damaged") "customer_return" else "unsold").put("uomCode",products[stock.productId]?.uomCode?:"PC")
                if(own.isEmpty()) lines.put(template.put("quantityBase",quantity.toString()))
                else own.forEach {b->lines.put(JSONObject(template.toString()).put("lotId",b.lotId).put("batch",b.batch).put("expiresAt",b.expiresAt?:JSONObject.NULL).put("qualityStatus",b.qualityStatus).put("quantityBase",b.quantityBase.toString()))}
            }
        }
        val custody=containerPosition()
        check(custody.all {!it.isNull("quantity")}) {"Physically count each configured container type first"}
        val empties=JSONArray(custody.map {JSONObject().put("typeCode",it.getString("typeCode")).put("quantity",it.getString("quantity"))})
        val pickups=dao.outboxRows(s,d).filter{it.tripId==t.tripId&&it.kind==RETURN_KIND}.map{JSONObject(it.operationJson).getJSONObject("payload")}
            .filter{it.optBoolean("custodyOnly")&&VanBootstrapCodec.objects(it.getJSONArray("lines")).any{l->l.getString("disposition")!="disposed_at_outlet"}}.map{it.getString("returnId")}
        append("unload.record",JSONObject().put("lines",lines).put("empties",empties).put("pendingPickups",JSONArray(pickups)))
    }
    suspend fun receiveReload(requestId: String): String = store.db.withTransaction {
        val t=checkNotNull(dao.trip(s,d));check(dao.stockReconciliation(s,d,t.tripId)==null && dao.cashReconciliation(s,d,t.tripId)==null)
        val request=checkNotNull(snapshot()?.optJSONArray("reloads")?.let(VanBootstrapCodec::objects)?.singleOrNull {it.getString("id")==requestId})
        val events=VanBootstrapCodec.objects(request.getJSONArray("events"))
        check(events.none {it.getString("kind")=="received"})
        check(dao.outboxRows(s,d).none {it.kind=="reload.receive" && JSONObject(it.operationJson).getJSONObject("payload").getString("requestId")==requestId})
        val dispatch=events.single {it.getString("kind")=="dispatched"}.getJSONObject("facts").getJSONArray("lines")
        val id=append("reload.receive",JSONObject().put("requestId",requestId).put("lines",dispatch))
        val at=checkNotNull(dao.outbox(s,d,id)).createdAt
        VanBootstrapCodec.objects(dispatch).forEachIndexed {i,l->dao.insertMovement(MovementRow(s,d,"reload:$id:$i",t.tripId,l.getString("productId"),"LOAD","available",l.getString("quantityBase").toLong(),null,id,at))}
        id
    }
    companion object { val KINDS=setOf("temperature.record","returnable.record","unload.record","reload.request","reload.receive","stop.record") }
}
