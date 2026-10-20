package com.sunpride.van.delivery

import com.sunpride.callflow.CallFlowEngine
import org.json.JSONArray
import org.json.JSONObject

/** F-303 F-304: domain validation only. Call ordering stays in CallFlowEngine. */
object DeliveryProofRules {
    fun validate(drop: JSONObject, payload: JSONObject) {
        require(payload.getString("dropId") == drop.getString("dropId"))
        require(payload.getString("receiverName").trim().isNotEmpty() && payload.getString("receiverName").length <= 100)
        val signature = payload.getJSONArray("signature")
        require(signature.length() in 2..2048)
        val points=(0 until signature.length()).map { i -> signature.getJSONArray(i).also { p ->
            require(p.length()==2 && (0..1).all { p.getDouble(it).isFinite() && p.getDouble(it) in 0.0..1.0 })
        }.toString() }
        require(points.distinct().size >= 2) { "Draw the receiver's signature." }
        val expected=CallFlowEngine.objects(drop.getJSONArray("lines"))
        val captured=CallFlowEngine.objects(payload.getJSONArray("lines"))
        require(captured.size==expected.size && captured.map { it.getString("lineId") }.distinct().size==expected.size)
        expected.forEach { line ->
            val l=captured.single { it.getString("lineId")==line.getString("lineId") }
            val quantities=listOf("acceptedBase","shortBase","rejectedBase","damagedBase").map { key ->
                val raw=l.get(key); require(raw is Number && raw.toDouble()==raw.toLong().toDouble())
                raw.toLong().also { require(it in 0..1_000_000_000L) }
            }
            require(quantities.sum()==line.getLong("expectedBase")) { "Accepted, short, rejected and damaged must equal expected pieces." }
            if(quantities.drop(1).sum()>0) require(CallFlowEngine.objects(drop.getJSONArray("reasons")).any { it.getString("code")==l.optString("reason") }) { "Choose a door variance reason." }
        }
        require(payload.getString("photoSha256").matches(Regex("[0-9a-f]{64}")))
        val watermark=payload.getJSONObject("watermark")
        require(watermark.getInt("version")==1 && watermark.getString("outletId")==drop.getString("outletId") && watermark.getLong("capturedAt")==payload.getLong("deviceTime"))
    }
    /** F-308: local preview uses the same persisted timing facts and queued journal as the proof. */
    fun validateTiming(drop:JSONObject,stage:String,at:Long,reason:String) {
        fun time(key:String)=if(drop.has(key)&&!drop.isNull(key)) drop.getLong(key) else null
        require(at>0)
        when(stage) {
            "arrival" -> {
                require(time("arrivedAt")==null) { "Arrival is already recorded." }
                val start=time("windowStart");val end=time("windowEnd")
                require(start==null || end==null || at in start..end || reason.isNotBlank()) { "Give a reason for arrival outside the receiving window." }
            }
            "unloading" -> require(time("unloadingAt")==null && time("arrivedAt")?.let { at>=it }==true) { "Record arrival before unloading." }
            "departure" -> require(time("departedAt")==null && time("unloadingAt")?.let {at>=it}==true && drop.getString("status") in setOf("saved_on_phone","delivered","variance")) { "Save delivery proof after unloading, then record departure." }
            else -> throw IllegalArgumentException("Choose arrival, unloading or departure.")
        }
    }
    fun fullLines(drop: JSONObject): JSONArray = JSONArray().apply { CallFlowEngine.objects(drop.getJSONArray("lines")).forEach { l ->
        put(JSONObject().put("lineId",l.getString("lineId")).put("acceptedBase",l.getLong("expectedBase")).put("shortBase",0).put("rejectedBase",0).put("damagedBase",0))
    } }
}
