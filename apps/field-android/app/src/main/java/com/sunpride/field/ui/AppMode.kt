package com.sunpride.field.ui

import org.json.JSONArray
import org.json.JSONObject

/**
 * SP-0195: the person's App mode, picked by the office. The phone shows only that mode's tabs (never more than four).
 * [wire] is the value `/api/me` sends in `profile.appMode`.
 */
enum class AppMode(val wire: String, val label: String, val line: String) {
    MAPPING("mapping", "Customer mapping", "Add and update customers"),
    VISITS("visits", "Field visits", "Store visits, route and orders"),
    SELLING("selling", "Truck selling", "Sell from the truck and print receipts");

    companion object {
        fun fromWire(value: Any?): AppMode? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * The office's App mode for this person ([mode]) and the modes they may switch between on the phone ([modes]; more than
 * one when the office enabled several). Read from the Field app's own `/api/me`.
 */
data class AppModes(val mode: AppMode, val modes: List<AppMode> = listOf(mode)) {
    /** Switch mode shows only when there is something to switch to. */
    val canSwitch: Boolean get() = modes.size > 1

    /**
     * The mode the phone shows: the owner's own choice on this phone when it is one of [modes], else the office's [mode].
     * Truck selling needs the Selling permission too ([sells]); without it the phone shows Field visits (no Sell work).
     */
    fun effective(choice: AppMode?, sells: Boolean): AppMode {
        val picked = if (choice != null && choice in modes) choice else mode
        return if (picked == AppMode.SELLING && !sells) AppMode.VISITS else picked
    }

    /** Kept on the phone between launches (and offline): `mode|m1,m2`. */
    fun encode(): String = "${mode.wire}|${modes.joinToString(",") { it.wire }}"

    companion object {
        /** An older server sends no App mode: sellers keep Truck selling, everyone else today's app without Sell. */
        fun fallback(selling: Boolean) = AppModes(if (selling) AppMode.SELLING else AppMode.VISITS)

        /**
         * From the `/api/me` answer. Missing or unknown `appMode` falls back on the Selling flag; `modes` keeps only the
         * known values (in the bar's order) and always includes [mode]. Never throws.
         */
        fun from(me: JSONObject?): AppModes {
            val profile = me?.optJSONObject("profile")
            val mode = AppMode.fromWire(profile?.opt("appMode") ?: me?.opt("appMode"))
                ?: return fallback(com.sunpride.field.sell.SellingFlag.from(me))
            val raw = profile?.optJSONArray("modes") ?: me?.optJSONArray("modes")
            return AppModes(mode, ordered(listOf(mode) + parse(raw)))
        }

        fun decode(text: String?, selling: Boolean): AppModes {
            val parts = text?.split("|") ?: return fallback(selling)
            val mode = AppMode.fromWire(parts.firstOrNull()) ?: return fallback(selling)
            val modes = parts.getOrNull(1)?.split(",")?.mapNotNull { AppMode.fromWire(it) }.orEmpty()
            return AppModes(mode, ordered(listOf(mode) + modes))
        }

        private fun parse(a: JSONArray?): List<AppMode> =
            if (a == null) emptyList() else (0 until a.length()).mapNotNull { AppMode.fromWire(a.opt(it)) }

        private fun ordered(modes: List<AppMode>) = modes.distinct().sortedBy { it.ordinal }
    }
}
