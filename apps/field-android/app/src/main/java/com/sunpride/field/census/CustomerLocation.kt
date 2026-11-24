package com.sunpride.field.census

import org.json.JSONObject

/** Add customer is best effort. Visit and Edit customer location rules are unchanged. */
object CustomerLocation {
    const val MAX_ACCURACY_METERS = 500.0
    const val MAX_AGE_MS = 30 * 60_000L
    private const val CLOCK_DRIFT_MS = 120_000L

    fun usable(fix: JSONObject?, at: Long): Boolean {
        if (fix == null) return false
        val latitude = fix.optDouble("latitude", Double.NaN)
        val longitude = fix.optDouble("longitude", Double.NaN)
        val accuracy = fix.optDouble("accuracyMeters", Double.NaN)
        val time = fix.optLong("fixTime", 0)
        return latitude.isFinite() && latitude in -90.0..90.0 && longitude.isFinite() && longitude in -180.0..180.0 &&
            accuracy.isFinite() && accuracy > 0 && accuracy <= MAX_ACCURACY_METERS && time > 0 &&
            time <= at + CLOCK_DRIFT_MS && time >= at - MAX_AGE_MS && fix.opt("mockSignal") == false &&
            fix.optString("provider") in listOf("gps", "fused", "network")
    }

    /** Never lose an earlier good reading when a retry fails or returns a weaker reading. */
    fun best(current: JSONObject?, candidate: JSONObject?, at: Long): JSONObject? {
        val old = current?.takeIf { usable(it, at) }
        val next = candidate?.takeIf { usable(it, at) } ?: return old
        if (old == null) return next
        val accuracy = next.getDouble("accuracyMeters").compareTo(old.getDouble("accuracyMeters"))
        return if (accuracy < 0 || (accuracy == 0 && next.getLong("fixTime") > old.getLong("fixTime"))) next else old
    }

    const val UNCONFIRMED = "Location not tagged yet. You can still save this customer. Go outside or near the door; GPS works without signal but needs a clear sky."
}
