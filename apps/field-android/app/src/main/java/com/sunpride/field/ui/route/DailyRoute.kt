package com.sunpride.field.ui.route

import com.sunpride.field.ui.VisitDisplay
import java.net.URLEncoder
import java.util.Locale
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt

/** Where the phone is. Only ever a foreground one-shot fix; never stored or sent from this screen. */
data class PhonePosition(val latitude: Double, val longitude: Double)

enum class StopState(val label: String) {
    NEXT("Next"), LATER("Later"), IN_PROGRESS("In progress"), DONE("Done"), REVIEW("Needs review")
}

data class RouteStop(
    /** 1-based position in today's MCP order. */
    val number: Int,
    val visit: VisitDisplay,
    val state: StopState,
    val distanceMeters: Double?,
    /** `geo:` URI any installed maps app can open, or null when the outlet has neither pin nor address. */
    val navigationUri: String?,
)

data class DailyRoute(val stops: List<RouteStop>) {
    val done get() = stops.count { it.state == StopState.DONE }
    val next get() = stops.firstOrNull { it.state == StopState.IN_PROGRESS || it.state == StopState.NEXT }
}

/**
 * Pure, offline projection of today's cached plan into the route the salesperson walks.
 * Order is the MCP sequence (or original download order when absent), the same rule the
 * call-order check uses, so the "Next" stop is always the one Start will accept.
 */
object DailyRoutes {
    fun build(visits: List<VisitDisplay>, position: PhonePosition?): DailyRoute {
        val ordered = visits.withIndex()
            .sortedBy { it.value.sequence ?: it.value.listPosition ?: it.index }.map { it.value }
        // A stop in review was not closed, so it still holds back later stops (no jumping ahead).
        val blocked = ordered.indexOfFirst { stateOf(it) != StopState.DONE }
        val open = ordered.any { stateOf(it) == StopState.IN_PROGRESS }
        return DailyRoute(ordered.mapIndexed { index, visit ->
            val raw = stateOf(visit)
            val state = when {
                raw != StopState.LATER -> raw
                index == blocked && !open -> StopState.NEXT
                else -> StopState.LATER
            }
            RouteStop(index + 1, visit, state, distance(position, visit), navigationUri(visit))
        })
    }

    private fun stateOf(visit: VisitDisplay) = when (visit.status) {
        "Done" -> StopState.DONE
        "In progress" -> StopState.IN_PROGRESS
        "Needs review" -> StopState.REVIEW
        else -> StopState.LATER
    }

    fun distance(position: PhonePosition?, visit: VisitDisplay): Double? {
        val lat = visit.latitude ?: return null
        val lng = visit.longitude ?: return null
        return haversine(position ?: return null, PhonePosition(lat, lng))
    }

    fun haversine(a: PhonePosition, b: PhonePosition): Double {
        val rad = Math.PI / 180
        val dLat = (b.latitude - a.latitude) * rad
        val dLon = (b.longitude - a.longitude) * rad
        val h = sin(dLat / 2).let { it * it } +
            cos(a.latitude * rad) * cos(b.latitude * rad) * sin(dLon / 2).let { it * it }
        return 2 * 6_371_000 * asin(sqrt(min(1.0, h)))
    }

    /** "80 m", "950 m", "1.2 km", "34 km": straight-line, so never more precise than useful. */
    fun formatDistance(meters: Double): String = when {
        meters < 1_000 -> "${((meters / 10).roundToInt() * 10).coerceAtLeast(10)} m"
        meters < 10_000 -> String.format(Locale.ENGLISH, "%.1f km", meters / 1_000)
        else -> "${(meters / 1_000).roundToInt()} km"
    }

    /**
     * Prefer the verified pin; fall back to a text search on the address. `geo:` opens the
     * user's chosen maps app (Google Maps, Waze, …) without a Google dependency here.
     */
    fun navigationUri(visit: VisitDisplay): String? {
        val lat = visit.latitude
        val lng = visit.longitude
        if (lat != null && lng != null) {
            val point = "${coordinate(lat)},${coordinate(lng)}"
            return "geo:$point?q=$point(${encode(visit.outlet)})"
        }
        val address = visit.address?.takeIf { it.isNotBlank() } ?: return null
        return "geo:0,0?q=${encode(address)}"
    }

    private fun coordinate(value: Double) = String.format(Locale.ENGLISH, "%.6f", value)
    private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
}
