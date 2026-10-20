package com.sunpride.callflow

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.*

/** F-006 F-107: this exact source is compiled by BOTH Android shells. No network, storage or UI dependency. */
class CallFlowRefused(message: String) : IllegalStateException(message)
object CallFlowEngine {
    private fun refuse(message: String): Nothing = throw CallFlowRefused(message)
    fun objects(a: JSONArray): List<JSONObject> = (0 until a.length()).map(a::getJSONObject)
    fun validate(config: JSONObject): JSONObject {
        val d = config.getJSONObject("definition"); require(d.getInt("version") > 0 && d.getString("id").isNotBlank())
        val steps = objects(d.getJSONArray("steps")); require(steps.size in 2..40)
        require(steps.map { it.getString("key") }.distinct().size == steps.size && steps.map { it.getString("adapter") }.distinct().size == steps.size)
        require(steps.first().getBoolean("required") && steps.last().getBoolean("required") && steps.first().getString("condition") == "always" && steps.last().getString("condition") == "always")
        require(steps.first().getString("adapter") == "check_in" && steps.last().getString("adapter") == "check_out")
        steps.forEach { require(it.getString("condition") in setOf("always","has_order","no_order")); it.getBoolean("required"); it.getString("label") }
        val p = config.getJSONObject("policy")
        require(p.getInt("radiusMeters") in 1..500 && p.getInt("maxAccuracyMeters") in 1..100 &&
            p.getLong("maxFixAgeMs") in 1_000L..300_000L && p.getLong("minDwellMs") in 0L..14_400_000L)
        require(objects(config.getJSONArray("reasons")).map { it.getString("code") }.distinct().size == config.getJSONArray("reasons").length())
        return config
    }
    /** F-106: no mock, approximate, old or missing fix may masquerade as a radius exception. */
    fun location(config: JSONObject, fix: JSONObject?, at: Long, approvedOutside: Boolean = false): Boolean {
        validate(config)
        val pin = config.optJSONObject("pin") ?: refuse("This store needs a verified location pin. Sync after office setup.")
        val policy = config.getJSONObject("policy")
        if (fix == null || fix.opt("mockSignal") != false || fix.optBoolean("integrityBlocked") ||
            fix.optString("provider") !in setOf("gps","network","fused")) refuse("A genuine location fix is required. Try again outside.")
        val lat = fix.optDouble("latitude",Double.NaN); val lon = fix.optDouble("longitude",Double.NaN)
        val accuracy = fix.optDouble("accuracyMeters",Double.NaN)
        if (!lat.isFinite() || lat !in -90.0..90.0 || !lon.isFinite() || lon !in -180.0..180.0 ||
            !accuracy.isFinite() || accuracy < 0 || accuracy > policy.getInt("maxAccuracyMeters") ||
            !fix.has("fixTime") || abs(at-fix.getLong("fixTime")) > policy.getLong("maxFixAgeMs"))
            refuse("Location is old or not accurate enough. Get a fresh fix outside.")
        val r = Math.PI / 180
        val h = sin((lat-pin.getDouble("latitude"))*r/2).pow(2) + cos(lat*r)*cos(pin.getDouble("latitude")*r)*sin((lon-pin.getDouble("longitude"))*r/2).pow(2)
        val distance = 2*6_371_000*asin(sqrt(h.coerceIn(0.0,1.0)))
        if (distance > policy.getInt("radiusMeters") && !approvedOutside)
            refuse("Outside the store radius. Move closer or request supervisor approval before starting.")
        return distance > policy.getInt("radiusMeters")
    }
    fun approval(config: JSONObject, kind: String, at: Long, used: Set<String> = emptySet(), policyId: String = config.getJSONObject("policy").optString("id")): String? = config.optJSONArray("geofenceApprovals")?.let(::objects)
        ?.firstOrNull { it.getString("id") !in used && it.optString("policyId",policyId) == policyId && it.getString("kind") == kind && it.getDouble("approvedAt") <= at && it.getDouble("expiresAt") > at }?.getString("id")
    fun applies(step: JSONObject, hasOrder: Boolean) = when(step.getString("condition")) {
        "always" -> true; "has_order" -> hasOrder; else -> !hasOrder
    }
    /** Adapters carry facts from existing transactional writers, never a UI-only done toggle. */
    fun advance(config: JSONObject, done: Set<String>, adapter: String, hasOrder: Boolean) {
        val steps = objects(validate(config).getJSONObject("definition").getJSONArray("steps"))
        val index = steps.indexOfFirst { it.getString("adapter") == adapter && applies(it,hasOrder) && it.getString("key") !in done }
        if (index < 0) {
            if (steps.any { it.getString("adapter") == adapter && it.getString("key") in done }) return
            refuse("This action is not part of this call flow. Sync its definition.")
        }
        val missing = steps.take(index).firstOrNull { it.getBoolean("required") && applies(it,hasOrder) && it.getString("key") !in done }
        if (missing != null) refuse("First complete: ${missing.getString("label")}")
    }
    fun keyFor(config: JSONObject, adapter: String): String? = objects(config.getJSONObject("definition").getJSONArray("steps"))
        .firstOrNull { it.getString("adapter") == adapter }?.getString("key")
    fun fieldAdapter(kind: String): String? = when(kind) {
        "visit.checkIn" -> "check_in"; "visit.checkOut" -> "check_out"
        "inventory_check","call_sheet" -> "stock_check"; "order_intent" -> "order_build"
        "note" -> "note"; "photo" -> "evidence"; "merchandising" -> "availability"
        "price_check" -> "price_check"; "promotion" -> "promotion"; else -> null
    }
    /** F-120 F-207: drafts/voids are explicitly excluded by the authoritative store's hasOrder argument. */
    fun close(config: JSONObject, done: Set<String>, hasOrder: Boolean, startedAt: Long, payload: JSONObject) {
        val at = payload.getLong("deviceTime")
        if (at < startedAt) refuse("Call end cannot be before check-in.")
        if (!hasOrder && objects(config.getJSONArray("reasons")).none { it.getString("code") == payload.optString("zeroSaleReason") })
            refuse("Choose a no-order reason from the list.")
        if (at-startedAt < config.getJSONObject("policy").getLong("minDwellMs") && payload.optString("shortCallReason").isBlank())
            refuse("This call is shorter than the store minimum. Give a reason for supervisor review.")
        advance(config,done,"check_out",hasOrder)
    }
}
