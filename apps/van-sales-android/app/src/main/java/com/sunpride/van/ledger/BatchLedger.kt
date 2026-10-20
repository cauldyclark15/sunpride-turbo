package com.sunpride.van.ledger

import com.sunpride.van.storage.RoomVanStore
import com.sunpride.van.storage.RouteOpsStore
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject

data class BatchPosition(val productId: String,val lotId: String,val batch: String,val expiresAt: Long?,val qualityStatus: String,val status: String,val quantityBase: Long)
data class BatchAllocation(val lotId: String,val batch: String,val expiresAt: Long?,val qualityStatus: String,val quantityBase: Long) {
    fun json()=JSONObject().put("lotId",lotId).put("batch",batch).put("expiresAt",expiresAt?:JSONObject.NULL).put("qualityStatus",qualityStatus).put("quantityBase",quantityBase.toString())
}
/** F-104 deterministic offline FEFO. Expired/held lots never become sellable from aggregate stock. */
object Fefo {
    fun allocate(positions: List<BatchPosition>,productId: String,quantity: Long,at: Long): List<BatchAllocation> {
        require(quantity>0)
        var left=quantity
        val allocated=mutableListOf<BatchAllocation>()
        positions.filter { it.productId==productId && it.status=="available" && it.qualityStatus=="released" && (it.expiresAt==null || it.expiresAt>at) && it.quantityBase>0 }
            .sortedWith(compareBy<BatchPosition> { it.expiresAt?:Long.MAX_VALUE }.thenBy { it.lotId }).forEach {
                if(left>0) { val take=minOf(left,it.quantityBase); allocated+=BatchAllocation(it.lotId,it.batch,it.expiresAt,it.qualityStatus,take); left-=take }
            }
        check(left==0L) { "Not enough unexpired, released batch stock" }
        check(allocated.size<=50) { "Split this sale: more than 50 batches are required" }
        return allocated
    }
}

/** F-104 the batch baseline and exact allocation bytes live in Room's encrypted trip/outbox rows. */
class BatchLedger(private val store: RoomVanStore) {
    private val dao=store.db.rows()
    private val s=store.scope.fullAuthSubject
    private val d=store.scope.deviceId
    private fun parse(o: JSONObject)=BatchPosition(o.getString("productId"),o.getString("lotId"),o.getString("batch"),
        if(o.isNull("expiresAt")) null else o.getLong("expiresAt"),o.getString("qualityStatus"),o.optString("status","available"),o.optString("quantityBase","0").toLong())
    suspend fun positions(): List<BatchPosition> {
        val t=dao.trip(s,d)?:return emptyList()
        val snapshot=RouteOpsStore(store).snapshot()?:return emptyList()
        val baseline= snapshot.optJSONArray("lots")?.let(VanBootstrapCodec::objects)?.map(::parse)?:emptyList()
        val amounts=baseline.associateBy { it.lotId to it.status }.toMutableMap()
        val loads=snapshot.optJSONArray("loadLots")?.let(VanBootstrapCodec::objects)?:emptyList()
        val baselineAt=dao.meta(s,d)?.lastBootstrapTime?:0
        val acks=dao.ackRows(s,d).associateBy { it.clientRequestId }
        val ops=dao.outboxRows(s,d).filter { it.tripId==t.tripId && it.status !in setOf("rejected","conflict") }.sortedBy { it.createdAt }
        fun delta(batch: BatchPosition,qty: Long) {
            val key=batch.lotId to batch.status
            val old=amounts[key]?:batch.copy(quantityBase=0)
            amounts[key]=old.copy(quantityBase=Math.addExact(old.quantityBase,qty))
        }
        for (op in ops) {
            if (StockProjection.reflected(acks[op.clientRequestId]?.serverTime,baselineAt)) continue
            val p=JSONObject(op.operationJson).getJSONObject("payload")
            if(op.kind=="load.confirm") VanBootstrapCodec.objects(p.getJSONArray("lines")).forEach { l ->
                loads.singleOrNull { it.getInt("lineNumber")==l.getInt("lineNumber") }?.let { delta(parse(it),l.getString("actualBase").toLong()) }
            }
            if(op.kind=="sale.record") VanBootstrapCodec.objects(p.getJSONArray("lines")).forEach { l->
                l.optJSONArray("allocations")?.let(VanBootstrapCodec::objects)?.forEach { a->delta(parse(JSONObject(a.toString()).put("productId",l.getString("productId"))),-a.getString("quantityBase").toLong()) }
            }
            if(op.kind=="return.record") VanBootstrapCodec.objects(p.getJSONArray("lines")).forEach {l->
                if(l.getString("stockEffect")!="none") l.optJSONArray("allocations")?.let(VanBootstrapCodec::objects)?.forEach {a->delta(parse(JSONObject(a.toString()).put("productId",l.getString("productId")).put("status",l.getString("stockEffect"))),a.getString("quantityBase").toLong())}
            }
            if(op.kind=="reload.receive") VanBootstrapCodec.objects(p.getJSONArray("lines")).filter {!it.isNull("lotId")}.forEach {l->
                val b=parse(JSONObject(l.toString()).put("status","available"))
                delta(b,l.getString("quantityBase").toLong())
                if(amounts.containsKey(b.lotId to "in_transit")) delta(b.copy(status="in_transit"),-l.getString("quantityBase").toLong())
            }
            if(op.kind=="stock.reconcile") p.optJSONArray("lotLines")?.let(VanBootstrapCodec::objects)?.forEach {l->delta(parse(l),Math.subtractExact(l.getString("countedBase").toLong(),l.getString("expectedBase").toLong()))}
            // Voids use the immutable original sale allocations, never today's FEFO order.
            if(op.kind=="sale.void") {
                val sale=ops.firstOrNull { it.kind=="sale.record" && JSONObject(it.operationJson).getJSONObject("payload").getString("saleId")==p.getString("saleId") }
                sale?.let { VanBootstrapCodec.objects(JSONObject(it.operationJson).getJSONObject("payload").getJSONArray("lines")).forEach { l->
                    l.optJSONArray("allocations")?.let(VanBootstrapCodec::objects)?.forEach { a->delta(parse(JSONObject(a.toString()).put("productId",l.getString("productId"))),a.getString("quantityBase").toLong()) }
                } }
            }
        }
        return amounts.values.toList()
    }
    suspend fun allocations(productId: String,quantity: Long,at: Long): List<BatchAllocation> {
        val route=RouteOpsStore(store).snapshot()?:return emptyList()
        val tracked=route.optJSONArray("trackedProducts")?.let(VanBootstrapCodec::objects)?.firstOrNull { it.getString("productId")==productId }
        if(tracked==null) return emptyList()
        val cutoff=Math.addExact(at,Math.multiplyExact(tracked.getLong("shelfLifeDays"),86_400_000L))
        return Fefo.allocate(positions(),productId,quantity,cutoff)
    }
}
