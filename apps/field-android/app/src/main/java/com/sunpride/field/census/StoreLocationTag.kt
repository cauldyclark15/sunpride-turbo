package com.sunpride.field.census

import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** SP-0251: bounded, encrypted session; later readings are separate immutable operations. */
object StoreLocationTag {
    const val KIND = "store.location"
    const val ENTITY = "local.store-location"
    const val WINDOW = 15 * 60_000L
    const val TIP = "Go outside or near the door; GPS works without signal but needs a clear sky."
    const val MISSING = "Location not tagged yet"
    /** Built from the queued bytes in the same transaction as Save, not from a later screen callback. */
    fun forCapture(intent: IntentRow, now: Long): JSONObject? {
        require(intent.kind == CensusRules.KIND)
        val payload = JSONObject(intent.serializedOperation).getJSONObject("payload")
        if (CensusRules.isChange(payload)) return null
        return start(payload.getString("captureId"), null, payload.optJSONObject("location"), now)
    }
    fun start(captureId: String?, outletId: String?, initial: JSONObject?, now: Long): JSONObject {
        require((captureId == null) != (outletId == null))
        val s = JSONObject().put("startedAt", now).put("captureId", captureId).put("outletId", outletId)
        initial?.takeIf { fresh(it, now) }?.let { s.put("anchor", it).put("best", it) }
        return s
    }
    fun fresh(fix: JSONObject, now: Long): Boolean = CustomerLocation.usable(fix, now) &&
        fix.optString("provider") == "gps" && kotlin.math.abs(now - fix.optLong("fixTime")) <= 120_000
    fun active(s: JSONObject, now: Long) = !s.optBoolean("stopped") && now >= s.getLong("startedAt") && now - s.getLong("startedAt") < WINDOW
    /** Never tag from a moving vehicle or after leaving the first measured store neighbourhood. */
    fun accept(s: JSONObject, fix: JSONObject, now: Long): Boolean {
        if (!active(s, now) || !fresh(fix, now) || fix.getLong("fixTime") < s.getLong("startedAt") - 10_000) return false
        val anchor = s.optJSONObject("anchor")
        val moved = anchor?.let { DuplicateRules.distanceMeters(it.getDouble("latitude"), it.getDouble("longitude"),
            fix.getDouble("latitude"), fix.getDouble("longitude")) } ?: 0.0
        if (fix.optDouble("speedMetersPerSecond", 0.0) > 2.5 || moved > 150) { s.put("stopped", true); return false }
        if (anchor == null) s.put("anchor", JSONObject(fix.toString()))
        val old = s.optJSONObject("best")
        if (old != null && fix.getDouble("accuracyMeters") >= old.getDouble("accuracyMeters")) return false
        s.put("best", JSONObject(fix.toString()))
        if (fix.getDouble("accuracyMeters") <= 15) s.put("stopped", true)
        return true
    }
    fun intent(scope: StoreScope, session: JSONObject, fix: JSONObject, now: Long): IntentRow {
        require(fresh(fix, now))
        val id = UUID.randomUUID().toString()
        val p = JSONObject().put("deviceTime", now).put("location", JSONObject(fix.toString()))
        session.optString("captureId").takeIf { it.isNotBlank() }?.let { p.put("captureId", it) }
        session.optString("outletId").takeIf { it.isNotBlank() }?.let { p.put("outletId", it) }
        val op = JSONObject().put("clientRequestId", id).put("kind", KIND).put("payload", p)
            .put("dependsOn", JSONArray().also { a -> p.optString("captureId").takeIf { it.isNotBlank() }?.let { a.put(it) } })
        return IntentRow(scope.account, scope.deviceId, scope.fingerprint, id, id, KIND, op.toString(), now)
    }
}
