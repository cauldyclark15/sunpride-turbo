package com.sunpride.van.storepos

import androidx.room.withTransaction
import com.sunpride.van.pos.OpeningFloat
import com.sunpride.van.storage.*
import kotlinx.coroutines.flow.combine
import org.json.JSONObject
import java.util.UUID

/** F-R01: no new database, price list, ledger or upload engine. */
data class StorePosConfig(val mode: String, val modeVersionId: String, val registerId: String?,
    val registerName: String?, val storeName: String?, val terminalCode: String?, val policyId: String?,
    val shift: CashierShift?, val details: JSONObject = JSONObject()) {
    companion object {
        fun decode(o: JSONObject): StorePosConfig {
            require(o.getInt("version")==1 && o.getString("mode") in setOf("van","store"))
            require(o.has("transactionsEnabled") && o.has("allowLocalSwitch"))
            fun nullable(key: String): String? = if(o.isNull(key)) null else o.getString(key)
            val mode=o.getString("mode")
            val id=UUID.fromString(o.getString("modeVersionId")).toString()
            val register=nullable("registerId")
            if(mode=="store") require(register!=null && nullable("policyId")!=null && nullable("storeName")!=null)
            return StorePosConfig(mode,id,register,nullable("registerName"),nullable("storeName"),nullable("terminalCode"),nullable("policyId"),
                o.optJSONObject("shift")?.let { CashierShift(it.getString("shiftId"),it.getLong("openedAt"),null) },o)
        }
    }
}
data class CashierShift(val shiftId: String,val openedAt: Long,val openingRequestId: String?)
data class StorePosState(val config: StorePosConfig?,val shift: CashierShift?,val queued: Int,val review: Int,val rows: List<OutboxRow> = emptyList())

/** F-R01: encrypted outbox is the local session journal. Count is never compared to expected cash on phone. */
class StorePosStore(private val store: RoomVanStore) {
    private val s=store.scope.fullAuthSubject
    private val d=store.scope.deviceId
    private val dao=store.db.rows()
    val state=combine(dao.observeSyncMeta(s,d),dao.observeOutbox(s,d)) { metas,rows ->
        val config=metas.singleOrNull()?.policyJson?.let { JSONObject(it).optJSONObject("storePos") }?.let(StorePosConfig::decode)
        project(config,rows)
    }
    internal suspend fun writable(): StorePosConfig {
        check(store.canSync()) {"This register needs a current office authorization"}
        return checkNotNull(dao.meta(s,d)?.policyJson?.let {JSONObject(it).optJSONObject("storePos")}?.let(StorePosConfig::decode))
            .also {check(it.mode=="store");check(it.policyId!=null)}
    }
    suspend fun open(openingCentavos: Long): String = store.db.withTransaction {
        require(floatProblem(openingCentavos)==null) {OpeningFloat.CAP_MESSAGE}
        val config=writable()
        val saved=dao.outboxRows(s,d)
        check(project(config,saved).shift==null) {"A cashier session is already open"}
        val zone=java.time.ZoneId.of("Asia/Manila")
        val day=java.time.Instant.ofEpochMilli(store.now()).atZone(zone).toLocalDate().toString()
        val localZ=saved.any {it.kind=="store.read" && it.status !in setOf("rejected","conflict","parked") && JSONObject(it.operationJson).getJSONObject("payload").let {p->p.optString("kind")=="z"&&java.time.Instant.ofEpochMilli(p.getLong("deviceTime")).atZone(zone).toLocalDate().toString()==day}}
        val remoteZ=StoreCheckout.objects(config.details.optJSONArray("reads")).any {it.getString("kind")=="z"&&it.getJSONObject("snapshot").getString("date")==day}
        check(!localZ&&!remoteZ){"This register has already closed its sales day"}
        val id=UUID.randomUUID().toString()
        queue("store.shift.open",id,config,JSONObject().put("openingCentavos",openingCentavos.toString()).put("policyId",config.policyId),id,null)
        id
    }
    suspend fun close(declaredCentavos: Long): String = store.db.withTransaction {
        require(declaredCentavos in 0..MAX_MONEY)
        val config=writable()
        val shift=checkNotNull(project(config,dao.outboxRows(s,d)).shift) {"Open a cashier session first"}
        queue("store.shift.close",shift.shiftId,config,JSONObject().put("declaredCentavos",declaredCentavos.toString()),UUID.randomUUID().toString(),shift.openingRequestId)
    }
    internal suspend fun queue(kind: String,shiftId: String,config: StorePosConfig,payload: JSONObject,id: String,dependency: String?,metadata: String? = null): String {
        val at=maxOf(store.now(),Math.addExact(dao.latestCreatedAt(s,d) ?: 0L,1L))
        payload.put("shiftId",shiftId).put("registerId",config.registerId).put("modeVersionId",config.modeVersionId).put("deviceTime",at)
        val op=JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",payload)
        val prior=dao.outboxRows(s,d).filter {it.kind in KINDS && it.status in setOf("pending","sending")}.maxByOrNull {it.createdAt}?.clientRequestId ?: dependency
        prior?.let {op.put("dependsOn",org.json.JSONArray().put(it))}
        dao.insertOutbox(OutboxRow(s,d,id,checkNotNull(config.registerId),kind,op.toString(),at,metadataJson=metadata,status="pending"))
        return id
    }
    companion object {
        const val MAX_MONEY=9_000_000_000L
        /** IP-P0: a store opening float is held to the office's ₱0..₱100,000 range, the same as a trip float; null when fine. */
        fun floatProblem(openingCentavos: Long): String? = if (OpeningFloat.valid(openingCentavos)) null else OpeningFloat.CAP_MESSAGE
        val KINDS=setOf("store.shift.open","store.shift.close","store.sale","store.void","store.refund","store.refund.part","store.read","store.receive","store.count","store.deposit","store.customer","store.print","store.cash","store.override","store.shift.suspend","store.shift.resume")
        fun project(config: StorePosConfig?,rows: List<OutboxRow>): StorePosState {
            val all=rows.filter {it.kind in KINDS}
            val relevant=all.filter {JSONObject(it.operationJson).getJSONObject("payload").optString("modeVersionId")==config?.modeVersionId}
            var shift=config?.shift
            for(row in relevant.filter {it.createdAt>=(config?.shift?.openedAt?:0) && it.createdAt>(config?.details?.optLong("closedThrough",0)?:0)}.sortedWith(compareBy<OutboxRow>{it.createdAt}.thenBy{it.clientRequestId})) {
                if(row.status in setOf("rejected","conflict","parked")) continue
                val p=JSONObject(row.operationJson).getJSONObject("payload")
                if(row.kind=="store.shift.open") shift=CashierShift(p.getString("shiftId"),p.getLong("deviceTime"),row.clientRequestId)
                else if(row.kind=="store.shift.close" && shift?.shiftId==p.getString("shiftId")) shift=null
            }
            return StorePosState(config,shift,all.count {it.status in setOf("pending","sending")},all.count {it.status in setOf("rejected","conflict")},rows)
        }
    }
}
