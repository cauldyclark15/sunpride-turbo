package com.sunpride.retail

import org.json.JSONArray
import org.json.JSONObject

/** F-211–F-219: shared field/van DTO and offline checklist. Recommendation math stays on the server. */
data class RetailLine(val productId: String, val code: String, val name: String, val uom: String,
    val scale: Long, val required: Boolean, val minimumBase: Long, val suggestedBase: Long,
    val reasons: List<String>, val objective: String?, val barcodes: List<String>)
data class RetailCall(val snapshotId: String, val outletId: String, val serviceDate: String,
    val label: String, val sample: Boolean, val lines: List<RetailLine>) {
    val required get() = lines.filter { it.required }
}
data class ShelfAnswer(val productId: String, val state: String = "not_checked", val method: String = "tap",
    val shelfBase: Long? = null, val backroomBase: Long? = null,
    val deliveredBase: Long? = null, val returnsBase: Long? = null)
object RetailAvailability {
    const val VERSION = "availability/2026-10-v1"
    fun decode(o: JSONObject): RetailCall? {
        require(o.getString("version") == VERSION)
        if (o.optBoolean("setupNeeded", true) || o.isNull("msl")) return null
        val a = o.getJSONArray("lines"); require(a.length() in 1..200)
        val lines = (0 until a.length()).map { i -> val l = a.getJSONObject(i)
            val reasons = l.getJSONArray("reasons"); require(reasons.length() <= 20)
            val codes = l.getJSONArray("barcodes"); require(codes.length() <= 500)
            RetailLine(l.getString("productId"),l.getString("code"),l.getString("name"),l.getString("uom"),
                l.getLong("quantityScale").also { require(it > 0) },l.getBoolean("required"),
                l.getLong("minimumBase").also { require(it > 0) },l.getLong("quantityBase").also { require(it >= 0) },
                (0 until reasons.length()).map { reasons.getString(it) },
                l.optString("objective").takeUnless { it.isBlank() || it == "null" },
                (0 until codes.length()).map { codes.getString(it) })
        }
        require(lines.map { it.productId }.distinct().size == lines.size)
        return RetailCall(o.getString("snapshotId"),o.getString("outletId"),o.getString("serviceDate"),
            o.getJSONObject("msl").getString("label"),o.optBoolean("sample"),lines)
    }
    fun complete(call: RetailCall, answers: List<ShelfAnswer>): Boolean = call.required.isNotEmpty() &&
        answers.map { it.productId }.distinct().size == answers.size && call.required.all { line ->
            answers.singleOrNull { it.productId == line.productId }?.state in setOf("present","absent") }
    fun validate(call: RetailCall, answers: List<ShelfAnswer>) {
        require(complete(call,answers)) { "Check every MSL line first" }
        require(answers.all { a -> call.required.any { it.productId == a.productId } && a.method in setOf("tap","scan") &&
            (a.shelfBase == null || a.shelfBase in 0L..1_000_000_000L) && (a.backroomBase == null || a.backroomBase in 0L..1_000_000_000L) &&
            (a.deliveredBase == null || a.deliveredBase in 0L..1_000_000_000L) && (a.returnsBase == null || a.returnsBase in 0L..1_000_000_000L) &&
            (a.state != "absent" || a.shelfBase == null || a.shelfBase == 0L) && (a.state != "present" || a.shelfBase != 0L) })
    }
    fun payload(call: RetailCall, answers: List<ShelfAnswer>, checkId: String, callKey: String, at: Long): JSONObject {
        validate(call,answers)
        return JSONObject().put("checkId",checkId).put("snapshotId",call.snapshotId).put("callKey",callKey)
            .put("deviceTime",at).put("complete",true).put("lines",JSONArray(answers.map { a ->
                JSONObject().put("productId",a.productId).put("state",a.state).put("method",a.method)
                    .put("shelfBase",a.shelfBase ?: JSONObject.NULL).put("backroomBase",a.backroomBase ?: JSONObject.NULL)
                    .put("deliveredBase",a.deliveredBase ?: JSONObject.NULL).put("returnsBase",a.returnsBase ?: JSONObject.NULL)
            }))
    }
    fun proposed(line: RetailLine, answer: ShelfAnswer?): Long = if (answer?.state == "absent") maxOf(line.minimumBase,line.suggestedBase) else line.suggestedBase
    fun scan(call: RetailCall, barcode: String): RetailLine? = call.required.singleOrNull { barcode == it.code || barcode in it.barcodes }
}
