package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import kotlin.math.abs

/** F-209/F-222: business forms outside a call, on the SAME encrypted intents/outbox and sync engine. */
object WorkforceForms {
    val KINDS = setOf("workforce.prospect", "workforce.clockIn", "workforce.clockOut")
    val PHOTO_TYPES = setOf("workforce_prospect", "workforce_clockin")
    fun day(at: Long) = Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Manila")).toLocalDate().toString()
    fun isForm(kind: String) = kind in KINDS
    fun photoType(kind: String) = if (kind == "workforce.prospect") "workforce_prospect" else "workforce_clockin"
    fun purpose(type: String) = when(type) { "workforce_prospect" -> "prospect-photo"; "workforce_clockin" -> "attendance-photo"; else -> "visit-photo" }
    fun payload(row: IntentRow) = JSONObject(row.serializedOperation).getJSONObject("payload")
    fun view(policy: WorkforcePolicy?, rows: List<Pair<IntentRow, String>>, at: Long): WorkforceView {
        val own = rows.filter { isForm(it.first.kind) }.map { (row,state) ->
            val p=payload(row)
            WorkforceEntry(row.requestId,row.kind,if(row.kind=="workforce.prospect") p.getString("name") else if(row.kind=="workforce.clockIn") "Clock-in" else "Clock-out",p.getLong("capturedAt"),state)
        }.sortedByDescending { it.at }
        val today=own.filter { day(it.at)==day(at) && it.state !in setOf("review","held") }
        val start=today.firstOrNull { it.kind=="workforce.clockIn" }
        val end=today.firstOrNull { it.kind=="workforce.clockOut" }
        return WorkforceView(policy,own,start?.id?:policy?.clockInRequestId,start?.at?:policy?.clockInAt,end?.at?:policy?.clockOutAt)
    }
    /** Local template is immutable. Only its stored server blob reference is materialized before send. */
    fun create(scope: StoreScope, policy: WorkforcePolicy, kind: String, name: String, answers: Map<String,String>,
        geo: JSONObject?, jpeg: ByteArray?, photoAt: Long, at: Long, clockInRequestId: String?, localParent: Boolean): Pair<IntentRow,EvidencePhotoRow?> {
        require(kind in KINDS && policy.valid(at)) { "Connect to refresh today's field forms." }
        require(if(kind=="workforce.prospect") policy.canProspect else policy.canClock) { "This form isn't available for your access." }
        val id=UUID.randomUUID().toString()
        val p=JSONObject().put("policyId",policy.id).put("policyVersion",policy.version).put("policyHash",policy.hash)
            .put("capturedAt",at).put("deviceTime",at)
        var photo: EvidencePhotoRow?=null
        if(kind!="workforce.clockOut") {
            val g=geo?:error("Capture a location before saving.")
            val fix=g.getLong("fixTime")
            require(abs(at-fix)<=policy.maxAgeSeconds*1000) { "Refresh the location before saving." }
            require(jpeg!=null && EvidencePhotos.isJpeg(jpeg) && jpeg.size.toLong() in 1..EvidencePhotos.MAX_BYTES && abs(at-photoAt)<=policy.maxAgeSeconds*1000) { "Take a recent photo before saving." }
            val wireGeo=JSONObject(g.toString()).put("takenAt",fix).also { it.remove("fixTime") }
            p.put("geo",wireGeo)
            val checksum=EvidencePhotos.sha256Hex(jpeg)
            p.put("photo",JSONObject().put("mime",EvidencePhotos.MIME).put("size",jpeg.size).put("checksum",checksum).put("capturedAt",photoAt))
            // These legacy local columns carry this form's aggregate UUID, never a fabricated server visit/outlet ID.
            photo=EvidencePhotoRow(scope.account,scope.deviceId,scope.fingerprint,id,id,id,id,photoType(kind),EvidencePhotos.MIME,jpeg.size.toLong(),checksum,photoAt,at)
        }
        if(kind=="workforce.prospect") {
            require(name.isNotBlank() && name.length<=200) { "Enter a prospect name." }
            val allowed=policy.fields.map { it.key }.toSet()
            require(answers.keys.all { it in allowed }) { "Refresh the KYC form." }
            for(field in policy.fields) {
                val value=answers[field.key].orEmpty()
                require((!field.required||value.isNotBlank()) && value.length<=field.maxLength &&
                    (field.type!="select"||(!field.required&&value.isBlank())||value in field.options)) { "Complete the required KYC fields." }
            }
            p.put("name",name).put("kyc",JSONObject().also { o-> answers.forEach { (k,v)->o.put(k,v) } })
        }
        val dependencies=JSONArray()
        if(kind=="workforce.clockOut") {
            require(!clockInRequestId.isNullOrBlank()) { "Clock in before closing the attendance day." }
            p.put("clockInRequestId",clockInRequestId)
            if(localParent)dependencies.put(clockInRequestId)
        }
        val operation=JSONObject().put("clientRequestId",id).put("kind",kind).put("dependsOn",dependencies).put("payload",p)
        return IntentRow(scope.account,scope.deviceId,scope.fingerprint,id,id,kind,operation.toString(),at) to photo
    }
}

data class WorkforceField(val key: String,val label: String,val type: String,val required: Boolean,val maxLength: Int,val options: List<String>)
data class WorkforcePolicy(val id: String,val version: Int,val hash: String,val label: String,val source: String,
    val validFrom: Long,val expiresAt: Long,val canProspect: Boolean,val canClock: Boolean,val fields: List<WorkforceField>,
    val maxAgeSeconds: Int,val clockInRequestId: String?,val clockInAt: Long?,val clockOutAt: Long?) {
    fun valid(at: Long)=at>=validFrom && at<expiresAt
    companion object {
        fun decode(o: JSONObject): WorkforcePolicy {
            fun number(key: String): Long { val n=o.get(key);require(n is Number);val l=n.toLong();require(n.toDouble().isFinite() && n.toDouble()==l.toDouble());return l }
            fun optional(key: String)=if(!o.has(key)||o.isNull(key)) null else number(key)
            fun flag(key: String): Boolean { val value=o.get(key);require(value is Boolean);return value }
            val id=o.getString("policyId");UUID.fromString(id)
            val version=number("version");require(version in 1..Int.MAX_VALUE.toLong())
            val hash=o.getString("contentHash");require(hash.matches(Regex("[0-9a-f]{64}")))
            val config=o.getJSONObject("configuration");val array=config.getJSONArray("fields")
            require(array.length() in 3..12)
            val fields=(0 until array.length()).map { i->val f=array.getJSONObject(i)
                val key=f.getString("key");val type=f.getString("type");require(key.matches(Regex("[a-z][A-Za-z0-9_]{0,31}")) && type in setOf("text","select") && f.get("required") is Boolean)
                val max=f.getInt("maxLength");require(max in 1..500)
                val options=f.optJSONArray("options")?.let { a->(0 until a.length()).map { a.getString(it) } }?:emptyList()
                require(type!="select"||options.isNotEmpty())
                WorkforceField(key,f.getString("label"),type,f.getBoolean("required"),max,options)
            }
            require(fields.map { it.key }.distinct().size==fields.size && listOf("address","channel","contactName").all { key->fields.any { it.key==key&&it.required } })
            val from=number("validFrom");val until=number("expiresAt");require(from>0&&until>from)
            val age=config.getInt("maxFixAgeSeconds");require(age in 1..900)
            val parent=if(o.isNull("clockInRequestId")) null else o.optString("clockInRequestId").takeIf { it.isNotBlank() }
            parent?.let { UUID.fromString(it) }
            return WorkforcePolicy(id,version.toInt(),hash,o.getString("label"),o.getString("sourceRef"),from,until,flag("canProspect"),flag("canClock"),fields,age,parent,optional("clockInAt"),optional("clockOutAt"))
        }
    }
}
data class WorkforceEntry(val id: String,val kind: String,val title: String,val at: Long,val state: String)
data class WorkforceView(val policy: WorkforcePolicy?=null,val entries: List<WorkforceEntry> = emptyList(),
    val clockInRequestId: String?=null,val clockInAt: Long?=null,val clockOutAt: Long?=null) {
    fun canClockIn(at: Long)=policy?.let { it.valid(at)&&it.canClock&&clockInRequestId==null }==true
    fun canClockOut(at: Long)=policy?.let { it.valid(at)&&it.canClock&&clockInRequestId!=null&&clockOutAt==null }==true
}
