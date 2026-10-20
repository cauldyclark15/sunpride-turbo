package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** F-310 F-311 F-315 F-320: domain forms ride the existing encrypted intent/outbox transaction.
 * Only immutable local visit/photo references are materialized from durable acknowledgements before send. */
object RetailCaptureQueue {
    const val KIND = "retail.capture"
    val KINDS = setOf("planogram", "posm", "freezer", "competitor", "promotion", "expiry", "issue_log")
    fun objects(a: JSONArray?): List<JSONObject> = if (a == null) emptyList() else (0 until a.length()).map { a.getJSONObject(it) }
    private fun whole(o: JSONObject, key: String, low: Long = 0, high: Long = 1_000_000_000): Long {
        val n = o.get(key)
        require(n is Int || n is Long) { "Use a whole number for $key" }
        return (n as Number).toLong().also { require(it in low..high) { "Check $key" } }
    }
    private fun text(o: JSONObject, key: String, max: Int = 200) = o.getString(key).also { require(it.isNotBlank() && it.length <= max) { "Enter $key" } }
    fun needsPhoto(kind: String, data: JSONObject) = !(kind in setOf("competitor", "issue_log") && data.optBoolean("noneObserved"))
    fun validateData(kind: String, d: JSONObject, snapshot: JSONObject, at: Long) {
        require(kind in KINDS)
        val masters = objects(snapshot.optJSONArray("masters"))
        when (kind) {
            "freezer" -> {
                val equipment = objects(snapshot.optJSONArray("equipment")).single { it.getString("id") == d.getString("equipmentVersionId") }.getJSONObject("data")
                require(text(d,"scannedSerial") == equipment.getString("serial")) { "Scan the serial on this store's equipment" }
                whole(d,"temperatureDeciC",-600,600); whole(d,"ownSharePercent",0,100)
                val measured = whole(d,"measuredAt",1,Long.MAX_VALUE)
                require(measured <= at && at - measured <= 3_600_000) { "Take a fresh temperature reading" }
            }
            "planogram" -> {
                val m = snapshot.getJSONObject("planogram")
                require(d.getString("masterVersionId") == m.getString("id"))
                val targets = objects(m.getJSONObject("data").getJSONArray("lines")); val lines=objects(d.getJSONArray("lines"))
                require(targets.size == lines.size && lines.map { it.getString("productId") }.distinct().size == lines.size)
                lines.forEach { line -> require(targets.any { it.getString("productId") == line.getString("productId") }); whole(line,"facings",0,10000); text(line,"position",100) }
                val own=whole(d,"ownFacings",0,1_000_000); val total=whole(d,"totalFacings",1,1_000_000)
                require(own <= total && own == lines.sumOf { it.getLong("facings") }) { "Own facings must match the product counts" }
            }
            "posm" -> {
                require(objects(snapshot.optJSONArray(if(d.optString("action")=="deploy") "issuedPosm" else "deployments")).any { it.getString("unit_code") == d.getString("unitCode") })
                require(d.get("present") is Boolean && d.getString("condition") in setOf("good","damaged","missing"))
                require(d.getBoolean("present") != (d.getString("condition") == "missing"))
            }
            "expiry" -> {
                val lines=objects(d.getJSONArray("lines")); require(lines.size in 1..200)
                require(lines.map { it.getString("productId")+"|"+it.getString("batch")+"|"+it.getString("expiryDate") }.distinct().size == lines.size)
                lines.forEach { line ->
                    require(masters.count { it.getString("kind") == "expiry_policy" && it.getJSONObject("data").getString("productId") == line.getString("productId") } == 1)
                    text(line,"batch",100); java.time.LocalDate.parse(line.getString("expiryDate"));whole(line,"quantityBase",1)
                }
            }
            "competitor" -> if (!d.optBoolean("noneObserved")) {
                require(d.getString("type") in setOf("price","promotion","new_sku","display","shelf_share"))
                text(d,"brand",100);text(d,"sku");text(d,"note",1000)
                if(d.getString("type") == "price") whole(d,"priceCentavos")
                if(d.getString("type") == "shelf_share") whole(d,"sharePercent",0,100)
                if(d.getString("type") in setOf("promotion","display")) text(d,"description",500)
            }
            "promotion" -> {
                val m=objects(snapshot.optJSONArray("campaigns")).single { it.getString("id") == d.getString("campaignVersionId") }
                listOf("display","price","posm","stock").forEach { require(d.get(it) is Boolean) }
                val checklist=d.getJSONArray("checklist");val targets=m.getJSONArray("checklist");require(checklist.length()==targets.length())
                objects(checklist).forEachIndexed { i,x -> require(x.getString("label")==targets.getString(i) && x.get("passed") is Boolean) }
            }
            "issue_log" -> if (!d.optBoolean("noneObserved")) {
                require(masters.any { it.getString("kind")=="incident_category" && it.getString("id")==d.getString("categoryVersionId") })
                text(d,"note",1000);val geo=d.getJSONObject("geo")
                require(geo.getDouble("latitude").isFinite() && geo.getDouble("latitude") in -90.0..90.0)
                require(geo.getDouble("longitude").isFinite() && geo.getDouble("longitude") in -180.0..180.0)
                require(geo.getDouble("accuracyMeters") in 0.0..1000.0 && kotlin.math.abs(at-geo.getLong("fixTime"))<=60000)
            }
        }
    }
    fun create(scope: StoreScope, start: IntentRow, previousId: String, kind: String, data: JSONObject,
        photos: List<String>, at: Long): IntentRow {
        val id=UUID.randomUUID().toString()
        val p=JSONObject().put("visitId","@checkin:${start.requestId}").put("deviceTime",at).put("requestKey",id)
            .put("kind",kind).put("data",JSONObject(data.toString())).put("localPhotoIds",JSONArray(photos))
        val op=JSONObject().put("kind",KIND).put("clientRequestId",id).put("dependsOn",JSONArray().put(previousId)).put("payload",p)
        return IntentRow(scope.account,scope.deviceId,scope.fingerprint,id,start.clientVisitId,KIND,op.toString(),at)
    }
    suspend fun validate(store: FieldStore, intent: IntentRow) {
        if(intent.kind != KIND) return
        val rows=store.history().map { it.first to it.second.state }
        val own=rows.filter { it.first.clientVisitId==intent.clientVisitId && it.second in setOf("pending","sending","done") }
        require(own.any { it.first.kind=="visit.checkIn" } && own.none { it.first.kind=="visit.checkOut" }) { "Start the call first, and capture before End" }
        val config=ConfiguredFieldCalls.config(rows,intent.clientVisitId) ?: error("Sync the merchandising configuration")
        val p=ConfiguredFieldCalls.payload(intent);val kind=p.getString("kind");val data=p.getJSONObject("data")
        validateData(kind,data,config.getJSONObject("retail"),p.getLong("deviceTime"))
        val photos=p.getJSONArray("localPhotoIds");val ids=(0 until photos.length()).map(photos::getString)
        require(ids.distinct().size==ids.size && ids.size<=20 && (!needsPhoto(kind,data) || ids.isNotEmpty())) { "Take a photo before saving the audit" }
        val available=store.visitPhotos(intent.clientVisitId)
        require(ids.all { id -> available.any { it.localId==id && it.state in setOf("pending","uploaded") } }) { "Choose photos from this call" }
    }
    /** Null means wait, not drop the audit or its dependent checkout. Same acknowledgements produce exact repeat bytes. */
    fun materialize(intent: IntentRow, photos: List<EvidencePhotoRow>): JSONObject? {
        val op=JSONObject(intent.serializedOperation)
        if(intent.kind!=KIND) return op
        val p=op.getJSONObject("payload");val ids=p.getJSONArray("localPhotoIds");val evidence=JSONArray()
        for(i in 0 until ids.length()) {
            val photo=photos.singleOrNull { it.localId==ids.getString(i) && it.clientVisitId==intent.clientVisitId } ?: return null
            if(photo.state!="uploaded" || photo.evidenceId.isNullOrBlank()) return null
            evidence.put(photo.evidenceId)
        }
        p.getJSONObject("data").put("evidenceIds",evidence);p.remove("localPhotoIds")
        return op
    }
}
