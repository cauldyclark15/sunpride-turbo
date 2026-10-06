package com.sunpride.van.ui

import com.sunpride.van.data.*
import java.math.BigDecimal
import java.math.MathContext

enum class Page { HOME, LOAD, START, STOCK, CUSTOMERS, WALK_IN, CUSTOMER, PRINTER }
data class NextAction(val page: Page, val label: String)

/** Display/validation only. The repository repeats every business check transactionally. */
object VanRules {
    const val MAX_BASE = 999_999_999_999_999_999L
    fun nextAction(trip: Trip?, load: Load?): NextAction = when {
        trip?.status == "loading" && load?.status == "planned" && !load.confirmPending -> NextAction(Page.LOAD, "Check the load")
        trip?.status == "loaded" && !trip.startPending -> NextAction(Page.START, "Start trip")
        else -> NextAction(Page.CUSTOMERS, "Customers")
    }
    fun status(trip: Trip?, load: Load?): String = when {
        trip == null -> "No trip today"
        trip.startPending -> "Starting… waiting for sync"
        load?.confirmPending == true -> "Load sent — waiting for sync"
        load?.status == "discrepancy" -> "Load waiting for supervisor"
        else -> when (trip.status) {
            "planned" -> "Planned"
            "loading" -> "Loading"
            "loaded" -> "Loaded — ready to start"
            "active" -> "On route"
            "closing" -> "Closing…"
            "closed" -> "Trip closed"
            "cancelled" -> "Trip cancelled"
            else -> "Check with your supervisor"
        }
    }
    fun quantity(base: Long, scale: Long): String {
        require(scale > 0)
        return BigDecimal.valueOf(base).divide(BigDecimal.valueOf(scale), MathContext.DECIMAL128).stripTrailingZeros().toPlainString()
    }
    fun parseQuantity(text: String, scale: Long): Long? = try {
        if (scale <= 0 || text.isBlank()) null else BigDecimal(text.trim()).multiply(BigDecimal.valueOf(scale)).longValueExact().takeIf { it in 0..MAX_BASE }
    } catch (_: ArithmeticException) { null } catch (_: NumberFormatException) { null }
    fun reasonRequired(expected: Long, actual: Long?): Boolean = actual != null && actual != expected
    fun canStart(trip: Trip?, truck: Boolean, route: Boolean): Boolean = trip?.status == "loaded" && !trip.startPending && truck && route && trip.vehicle != null && trip.route != null
    fun canConfirm(trip: Trip?, load: Load?): Boolean = trip?.status == "loading" && load?.status == "planned" && !load.confirmPending
    fun reasonLabel(code: String): String = when (code) {
        "short_loaded" -> "Short loaded"
        "over_loaded" -> "Over loaded"
        "damaged_at_loading" -> "Damaged at loading"
        "wrong_item" -> "Wrong item"
        "crushed" -> "Crushed"
        "leaking" -> "Leaking"
        "expired" -> "Expired"
        "spoiled" -> "Spoiled"
        else -> "Other"
    }
    fun sourceLabel(source: String): String = when (source) { "route" -> "Route"; "unplanned" -> "Not on route"; else -> "Walk-in" }
}
