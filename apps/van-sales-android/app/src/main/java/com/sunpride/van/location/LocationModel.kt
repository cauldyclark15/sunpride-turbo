package com.sunpride.van.location

import com.sunpride.van.data.Trip
import com.sunpride.van.sync.VanWireFailure
import com.sunpride.van.sync.VanWireSchema
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * SP-0137 live map: the van shares the truck's location ONLY while its trip is active
 * (trip started on this phone → trip closed on this phone, or sign-out). Server side:
 * `packages/backend/convex/location` (`/van/v1/location`, SP-0135). Cadence mirrors
 * `LOCATION_POLICY` there.
 */
object LocationPolicy {
    /** Record about every 60 s while moving, or sooner after 50 m. */
    const val MOVING_INTERVAL_MS = 60_000L
    const val MOVING_DISTANCE_M = 50.0
    /** Record every 5 minutes while the truck stands still. */
    const val STILL_INTERVAL_MS = 5 * 60_000L
    /** Moving at or above this speed (m/s, ~3.6 km/h), same as the server's live status. */
    const val MOVING_SPEED = 1.0
    /** The server refuses two pings from one person closer than 10 s (start/stop exempt). */
    const val MIN_SPACING_MS = 10_000L
    /** How often the phone asks the GPS for a fix; the cadence above decides what is kept. */
    const val FIX_REQUEST_MS = 15_000L
    /** Pings per upload (server maxBatch). */
    const val MAX_BATCH = 100
    /** The server refuses buffered pings older than 7 days; the phone drops them then. */
    const val MAX_AGE_MS = 7 * 24 * 3_600_000L
    /** Ask for an upload after this many waiting pings, or this long after the last one. */
    const val UPLOAD_AFTER_PINGS = 5
    const val UPLOAD_AFTER_MS = 5 * 60_000L
    /** Fixes worse than this are not worth a dot on a map. */
    const val MAX_ACCURACY_M = 500.0
}

/** One position from the phone's location provider. */
data class LocationFix(val recordedAt: Long, val latitude: Double, val longitude: Double, val accuracyMeters: Double,
    val speedMetersPerSecond: Double?, val headingDegrees: Double?, val provider: String, val mockLocation: Boolean) {
    init {
        require(latitude.isFinite() && longitude.isFinite() && kotlin.math.abs(latitude) <= 90 && kotlin.math.abs(longitude) <= 180)
        require(provider in PROVIDERS)
    }
    companion object {
        val PROVIDERS = setOf("gps","network","fused","unknown")
        /** Android provider names to the wire's; anything else is `unknown`. */
        fun provider(name: String?): String = when (name) { "gps" -> "gps"; "network" -> "network"; "fused" -> "fused"; else -> "unknown" }
    }
}

/** What was last kept for the current trip, so the cadence survives a service restart. */
data class LastPing(val recordedAt: Long, val latitude: Double, val longitude: Double, val trigger: String)

object PingCadence {
    /** Great-circle distance in metres. */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2-lat1); val dLng = Math.toRadians(lng2-lng1)
        val a = sin(dLat/2).pow(2)+cos(Math.toRadians(lat1))*cos(Math.toRadians(lat2))*sin(dLng/2).pow(2)
        return 2*r*asin(sqrt(a.coerceIn(0.0,1.0)))
    }

    /**
     * The trigger to record [fix] with, or null to skip it. First fix of a trip = `start`.
     * Moving: every 60 s or 50 m. Still: every 5 min. Never closer than the server's 10 s
     * spacing, and never older than (or equal to) the last kept ping.
     */
    fun decide(last: LastPing?, fix: LocationFix): String? {
        if (!fix.accuracyMeters.isFinite() || fix.accuracyMeters < 0 || fix.accuracyMeters > LocationPolicy.MAX_ACCURACY_M) return null
        if (last == null) return "start"
        val elapsed = fix.recordedAt-last.recordedAt
        if (elapsed < LocationPolicy.MIN_SPACING_MS) return null
        val moved = distanceMeters(last.latitude,last.longitude,fix.latitude,fix.longitude)
        val moving = (fix.speedMetersPerSecond ?: 0.0) >= LocationPolicy.MOVING_SPEED || moved >= LocationPolicy.MOVING_DISTANCE_M
        return when {
            moving && (elapsed >= LocationPolicy.MOVING_INTERVAL_MS || moved >= LocationPolicy.MOVING_DISTANCE_M) -> "moving"
            !moving && elapsed >= LocationPolicy.STILL_INTERVAL_MS -> "still"
            else -> null
        }
    }
}

/** Whether this phone should be sharing the truck's location now. */
object TripTracking {
    /** On the road: the trip is active on the server or its start is saved here, and it is not closed on this phone. */
    fun tripOnRoad(trip: Trip?, tripClosed: Boolean): Boolean =
        trip != null && !tripClosed && (trip.status == "active" || trip.startPending)

    fun shouldTrack(signedIn: Boolean, trip: Trip?, tripClosed: Boolean, consented: Boolean, permitted: Boolean): Boolean =
        signedIn && consented && permitted && tripOnRoad(trip,tripClosed)
}

/** What the seller sees about location sharing. */
enum class SharingState {
    /** No trip on the road: nothing is shared (and the indicator is not shown). */
    NOT_ON_TRIP,
    /** The trip is on the road and the location is being shared. */
    ON,
    /** On the road, but the seller has not agreed to location sharing yet. */
    NEEDS_CONSENT,
    /** Agreed, but Android location permission (or location itself) is off. */
    NEEDS_PERMISSION,
}

object SharingRules {
    fun state(trip: Trip?, tripClosed: Boolean, consented: Boolean, permitted: Boolean): SharingState = when {
        !TripTracking.tripOnRoad(trip,tripClosed) -> SharingState.NOT_ON_TRIP
        !consented -> SharingState.NEEDS_CONSENT
        !permitted -> SharingState.NEEDS_PERMISSION
        else -> SharingState.ON
    }
    fun label(state: SharingState): String = when (state) {
        SharingState.ON -> "Location sharing on"
        SharingState.NEEDS_CONSENT, SharingState.NEEDS_PERMISSION -> "Location sharing off"
        SharingState.NOT_ON_TRIP -> "Location sharing off — not on a trip"
    }
    fun detail(state: SharingState): String = when (state) {
        SharingState.ON -> "Your supervisors see the truck on the map until you close the trip"
        SharingState.NEEDS_CONSENT -> "Tap to read what is shared and turn it on"
        SharingState.NEEDS_PERMISSION -> "Allow location for Sunpride Van to turn it on"
        SharingState.NOT_ON_TRIP -> "Shared only while a trip is active"
    }
}

/** The plain-words consent text (Data Privacy Act of 2012, RA 10173). Bump [VERSION] when it changes. */
object LocationConsentText {
    const val VERSION = 1
    const val TITLE = "Sharing the truck's location"
    val POINTS = listOf(
        "What: the truck's position from this handheld — place, how accurate it is, speed and direction, battery level, and whether the location looks faked.",
        "When: only while your trip is active — from Start trip until you close the trip or sign out. Never before or after. A notification shows while it is on.",
        "Who sees it: your supervisors and managers for your area, and the Sunpride office, on the live map. Other sellers do not.",
        "Why: to see where trucks are during the day, plan routes and help you if something goes wrong.",
        "How long: kept for 90 days, then deleted automatically.",
        "Your choice: you can still sell without it. You can turn it on later from Today. Questions or corrections: ask your supervisor or the Sunpride data protection officer.",
    )
}

/** Wire codec for `POST /van/v1/location` (`packages/domain-contracts/schemas/van-v1.schema.json`). */
object LocationPingCodec {
    data class Result(val clientPingId: String, val status: String, val code: String?)

    /** Frozen ping JSON (no deviceId); recorded once and sent byte-identical on every retry. */
    fun ping(clientPingId: String, tripId: String, fix: LocationFix, trigger: String, batteryPercent: Int?): String {
        require(trigger in setOf("start","moving","still","stop"))
        val o = JSONObject().put("clientPingId",clientPingId).put("recordedAt",fix.recordedAt)
            .put("latitude",fix.latitude).put("longitude",fix.longitude)
            .put("accuracyMeters",fix.accuracyMeters.coerceIn(0.0,100_000.0))
            .put("speedMetersPerSecond",fix.speedMetersPerSecond?.takeIf { it.isFinite() && it >= 0 }?.coerceAtMost(100.0) ?: JSONObject.NULL)
            .put("headingDegrees",fix.headingDegrees?.takeIf { it.isFinite() && it in 0.0..360.0 } ?: JSONObject.NULL)
            .put("batteryPercent",batteryPercent?.takeIf { it in 0..100 } ?: JSONObject.NULL)
            .put("mockLocation",fix.mockLocation).put("provider",fix.provider).put("trigger",trigger).put("tripId",tripId)
        request("validation-device",listOf(o.toString())) // throws when the ping breaks the contract
        return o.toString()
    }

    fun newPingId(): String = UUID.randomUUID().toString()

    fun request(deviceId: String, pings: List<String>): ByteArray {
        require(pings.size in 1..LocationPolicy.MAX_BATCH)
        val o = JSONObject().put("type","van.location.request").put("contractVersion",1).put("deviceId",deviceId)
            .put("pings",JSONArray(pings.map { JSONObject(it) }))
        validate(o)
        return o.toString().toByteArray(Charsets.UTF_8)
    }

    /** Exactly one result per sent ping, nothing else; anything else is a wire failure. */
    fun results(text: String, sent: List<String>): List<Result> {
        val o = try { JSONObject(text) } catch (_: Exception) { throw VanWireFailure() }
        validate(o)
        if (o.getString("type") != "van.location.response") throw VanWireFailure()
        val arr = o.getJSONArray("results")
        val results = (0 until arr.length()).map { i -> arr.getJSONObject(i).let { Result(it.getString("clientPingId"),it.getString("status"),it.optString("code").takeIf { c -> c.isNotEmpty() }) } }
        if (results.size != sent.size || results.map { it.clientPingId } != sent) throw VanWireFailure()
        return results
    }

    private fun validate(o: JSONObject) = VanWireSchema.validate(o)
}
