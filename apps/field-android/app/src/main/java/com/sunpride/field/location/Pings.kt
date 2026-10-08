package com.sunpride.field.location

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/** One position from the phone, before it becomes a wire ping. */
data class Fix(val latitude: Double, val longitude: Double, val accuracyMeters: Double,
    val speedMetersPerSecond: Double?, val headingDegrees: Double?, val mockLocation: Boolean,
    /** Device clock (epoch ms) of the fix. */
    val time: Long)

/**
 * Battery-friendly cadence (SP-0136): about every 60 s or 50 m while moving, every 5 min while
 * still. The server keeps its own 10 s floor (LOCATION_POLICY.minSpacingMs); the phone stays above
 * it with a margin so a batched delivery never trips `too_frequent`.
 */
object PingCadence {
    const val MOVING_INTERVAL_MS = 60_000L
    const val MOVING_DISTANCE_M = 50.0
    const val STILL_INTERVAL_MS = 5 * 60_000L
    const val MIN_SPACING_MS = 15_000L
    /** ~3.6 km/h, the server's own "moving" threshold. */
    const val MOVING_SPEED = 1.0

    /** "moving" / "still" when [fix] should be recorded after [last]; null to skip it. */
    fun decide(last: Fix?, fix: Fix): String? {
        if (last == null) return "start"
        val elapsed = fix.time - last.time
        if (elapsed < MIN_SPACING_MS) return null
        val distance = distanceMeters(last, fix)
        // Balanced-power fixes can wander by their accuracy radius while standing still: only a move
        // past both fixes' accuracy counts as displacement.
        val displaced = distance >= MOVING_DISTANCE_M && distance > maxOf(fix.accuracyMeters, last.accuracyMeters)
        val moving = (fix.speedMetersPerSecond ?: 0.0) >= MOVING_SPEED || displaced
        return when {
            moving && (elapsed >= MOVING_INTERVAL_MS || displaced) -> "moving"
            elapsed >= STILL_INTERVAL_MS -> "still"
            else -> null
        }
    }

    fun distanceMeters(a: Fix, b: Fix): Double {
        val r = 6_371_000.0
        val p1 = Math.toRadians(a.latitude); val p2 = Math.toRadians(b.latitude)
        val dp = p2 - p1; val dl = Math.toRadians(b.longitude - a.longitude)
        val h = sin(dp / 2).pow(2) + cos(p1) * cos(p2) * sin(dl / 2).pow(2)
        return 2 * r * asin(sqrt(h.coerceIn(0.0, 1.0)))
    }
}

/**
 * The server visit a ping belongs to: the latest Start whose call has no End yet and whose ack
 * (with the server visit ID) is already stored. Unacknowledged offline calls send no visitId — the
 * wire field must be a real server ID, never a local placeholder.
 */
object OpenVisit {
    /** Request ID of the open, delivered Start; its ack carries the server visit ID. */
    fun checkInRequestId(history: List<Pair<com.sunpride.field.storage.IntentRow, String>>): String? {
        val ended = history.filter { it.first.kind == "visit.checkOut" && it.second != "review" }
            .map { it.first.clientVisitId }.toSet()
        return history.lastOrNull { (row, state) ->
            row.kind == "visit.checkIn" && state == "done" && row.clientVisitId !in ended
        }?.first?.requestId
    }
    fun serverId(entityId: String?): String? = entityId?.takeIf { it.length in 1..64 }
}

/**
 * The v1 `/mobile/v1/location` wire shape (`packages/domain-contracts/schemas/mobile-v1.schema.json`,
 * fixtures `location-request.json` / `location-response.json`). Values are clamped to the ranges the
 * server validates so one odd sensor reading never rejects a whole batch.
 */
object PingCodec {
    const val PATH = "/mobile/v1/location"
    const val MAX_BATCH = 100
    val TRIGGERS = setOf("start", "moving", "still", "stop")
    val PROVIDERS = setOf("gps", "network", "fused", "unknown")

    fun ping(fix: Fix, trigger: String, batteryPercent: Int?, visitId: String?, provider: String = "fused",
        recordedAt: Long = fix.time, clientPingId: String = UUID.randomUUID().toString()): JSONObject {
        require(trigger in TRIGGERS && provider in PROVIDERS)
        require(fix.latitude.isFinite() && fix.longitude.isFinite() && kotlin.math.abs(fix.latitude) <= 90 &&
            kotlin.math.abs(fix.longitude) <= 180)
        val o = JSONObject().put("clientPingId", clientPingId).put("recordedAt", recordedAt)
            .put("latitude", fix.latitude).put("longitude", fix.longitude)
            .put("accuracyMeters", fix.accuracyMeters.takeIf { it.isFinite() }?.coerceIn(0.0, 100_000.0) ?: 100_000.0)
            .put("speedMetersPerSecond", fix.speedMetersPerSecond?.takeIf { it.isFinite() }?.coerceIn(0.0, 100.0) ?: JSONObject.NULL)
            .put("headingDegrees", fix.headingDegrees?.takeIf { it.isFinite() }?.coerceIn(0.0, 360.0) ?: JSONObject.NULL)
            .put("batteryPercent", batteryPercent?.coerceIn(0, 100) ?: JSONObject.NULL)
            .put("mockLocation", fix.mockLocation).put("provider", provider).put("trigger", trigger)
        if (visitId != null && visitId.length in 1..64) o.put("visitId", visitId)
        return o
    }

    fun request(deviceId: String, pings: List<String>): ByteArray {
        require(pings.size in 1..MAX_BATCH)
        val a = JSONArray(); pings.forEach { a.put(JSONObject(it)) }
        return JSONObject().put("type", "location.request").put("contractVersion", 1).put("deviceId", deviceId)
            .put("pings", a).toString().toByteArray(Charsets.UTF_8)
    }

    data class Result(val clientPingId: String, val status: String, val code: String?)

    /** One result per sent ping, in request order; anything else is a malformed answer. */
    fun results(text: String, sent: List<String>): List<Result> {
        val o = JSONObject(text)
        check(o.getString("type") == "location.response" && o.getInt("contractVersion") == 1 && o.has("serverTime"))
        val a = o.getJSONArray("results")
        check(a.length() == sent.size)
        return sent.indices.map { i ->
            val r = a.getJSONObject(i)
            check(r.getString("clientPingId") == sent[i])
            Result(sent[i], r.getString("status"), r.optString("code").takeIf { it.isNotBlank() })
        }
    }
}
