package com.sunpride.field.ui.diagnosticvisit

import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Display-only mirror of the server's `VISIT_LOCATION_POLICY` (packages/backend/convex/visits/policy.ts).
 * The server alone decides the distance/geofence result against the verified outlet pin; the phone never
 * sends a within-geofence flag. These thresholds only let the phone tell the salesperson, at Start/End,
 * that a fix will go to supervisor review. Client answer 13: no distance limit, never block a check-in.
 */
object LocationPolicy {
    const val VERSION = "field-day-2026-10-v3"
    const val MAX_ACCURACY_METERS = 50.0
    const val MAX_FIX_AGE_MS = 60_000L
    /** How long the phone keeps listening for a better fix before using the best one it has. */
    const val CAPTURE_BUDGET_MS = 15_000L
}

/** One v1 wire location: coordinates, horizontal accuracy, fix time, provider and mock indicator. */
data class LocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val fixTime: Long,
    val provider: String,
    val mockSignal: Boolean,
) {
    init {
        require(latitude.isFinite() && kotlin.math.abs(latitude) <= 90)
        require(longitude.isFinite() && kotlin.math.abs(longitude) <= 180)
        require(accuracyMeters.isFinite() && accuracyMeters >= 0)
        require(fixTime > 0)
        require(provider in PROVIDERS)
    }

    fun toJson(): JSONObject = JSONObject().put("latitude", latitude).put("longitude", longitude)
        .put("accuracyMeters", accuracyMeters).put("fixTime", fixTime)
        .put("provider", provider).put("mockSignal", mockSignal)

    companion object {
        val PROVIDERS = setOf("gps", "network", "fused", "unknown")
        fun provider(raw: String?): String = when (raw) { "gps" -> "gps"; "network" -> "network"; "fused" -> "fused"; else -> "unknown" }

        /** Parses a fix produced by a [VisitLocation]; malformed values are not evidence. */
        fun fromJson(json: JSONObject?): LocationFix? = try {
            json?.let {
                LocationFix(it.getDouble("latitude"), it.getDouble("longitude"), it.getDouble("accuracyMeters"),
                    it.getLong("fixTime"), provider(it.optString("provider")), it.optBoolean("mockSignal", false))
            }
        } catch (_: Exception) { null }
    }
}

enum class UnavailableReason { PERMISSION_DENIED, LOCATION_OFF, NO_FIX }

sealed interface LocationCapture {
    data class Captured(val fix: LocationFix) : LocationCapture
    data class Unavailable(val reason: UnavailableReason) : LocationCapture
    val wire: JSONObject? get() = (this as? Captured)?.fix?.toJson()
}

/** Picks the fix the server is most likely to accept from a stream of fused/GPS/network updates. */
object FixSelector {
    fun reliable(fix: LocationFix, at: Long): Boolean = !fix.mockSignal && fix.provider != "unknown" &&
        fix.accuracyMeters <= LocationPolicy.MAX_ACCURACY_METERS && fix.fixTime <= at &&
        at - fix.fixTime <= LocationPolicy.MAX_FIX_AGE_MS

    /** Fresh beats stale, then a non-mock fix beats a mock one, then the tighter accuracy wins. */
    fun better(current: LocationFix?, candidate: LocationFix, at: Long): LocationFix {
        if (current == null) return candidate
        fun rank(f: LocationFix) = Triple(
            if (f.fixTime <= at && at - f.fixTime <= LocationPolicy.MAX_FIX_AGE_MS) 0 else 1,
            if (f.mockSignal) 1 else 0, f.accuracyMeters)
        val (a, b) = rank(current) to rank(candidate)
        val cmp = compareValuesBy(b, a, { it.first }, { it.second }, { it.third })
        return when {
            cmp < 0 -> candidate
            cmp > 0 -> current
            else -> if (candidate.fixTime > current.fixTime) candidate else current
        }
    }
}

/** What the salesperson sees after Start/End. Review is a flag for the supervisor, never a refusal. */
data class LocationNotice(val text: String, val review: Boolean)

object LocationAssessment {
    fun reviewReasons(fix: LocationFix, at: Long): List<String> = buildList {
        if (fix.mockSignal) add("mock location detected")
        if (fix.provider == "unknown") add("unknown location source")
        if (fix.accuracyMeters > LocationPolicy.MAX_ACCURACY_METERS) add("weak signal")
        if (fix.fixTime > at || at - fix.fixTime > LocationPolicy.MAX_FIX_AGE_MS) add("old fix")
    }

    fun notice(capture: LocationCapture, at: Long): LocationNotice = when (capture) {
        is LocationCapture.Captured -> {
            val accuracy = "±${capture.fix.accuracyMeters.roundToInt()} m"
            val reasons = reviewReasons(capture.fix, at)
            if (reasons.isEmpty()) LocationNotice("Location recorded · $accuracy", false)
            else LocationNotice("Location recorded · $accuracy · supervisor will review: ${reasons.joinToString(", ")}", true)
        }
        is LocationCapture.Unavailable -> LocationNotice("Location unavailable · supervisor will review: " + when (capture.reason) {
            UnavailableReason.PERMISSION_DENIED -> "location permission off"
            UnavailableReason.LOCATION_OFF -> "phone location turned off"
            UnavailableReason.NO_FIX -> "no signal"
        }, true)
    }
}
