package com.sunpride.field.ui.truckstock

import org.json.JSONArray
import org.json.JSONObject

/**
 * SP-0227 weekly truck stock. The office records what the warehouse actually loaded (served); the salesman counts
 * what is left on Saturday and gives a reason. The cashier counts him on loaded − sold − counted, never the request.
 */
object TruckStock {
    const val KIND = "truckweek"
    const val OP = "truckweek.capture"

    data class Line(val productId: String, val name: String, val code: String, val uom: String,
        val requested: Long, val served: Long, val sold: Long, val counted: Long?, val reasonId: String?, val note: String?) {
        /** What should still be on the truck by the phone's last download. */
        val expectedLeft: Long get() = served - sold
        val short: Long get() = maxOf(0, requested - served)
    }
    data class Reason(val id: String, val name: String)
    data class Week(val id: String, val weekStart: String, val status: String, val lines: List<Line>, val reasons: List<Reason>)

    fun decode(data: JSONObject?): Week? {
        val w = data?.optJSONObject("week") ?: return null
        val lines = w.getJSONArray("lines")
        require(lines.length() <= 300)
        val reasons = data.optJSONArray("reasons") ?: JSONArray()
        return Week(w.getString("id"), w.getString("weekStart"), w.getString("status"),
            (0 until lines.length()).map { lines.getJSONObject(it) }.filter { !it.optBoolean("notLoaded") }.map { l ->
                Line(l.getString("productId"), l.getString("name"), l.getString("code"), l.optString("uom"),
                    l.getLong("requestedBase"), l.getLong("servedBase"), l.getLong("soldBase"),
                    if (l.isNull("countedBase")) null else l.getLong("countedBase"),
                    l.optString("reasonId").takeIf { !l.isNull("reasonId") && it.isNotBlank() },
                    l.optString("note").takeIf { !l.isNull("note") && it.isNotBlank() })
            },
            (0 until reasons.length()).map { reasons.getJSONObject(it) }.map { Reason(it.getString("id"), it.getString("name")) })
    }

    /** A reason is needed only when the count differs from what should be left; a balanced line needs none. */
    fun needsReason(line: Line, counted: Long): Boolean = counted != line.expectedLeft

    /** Plain words for the difference loaded − sold − counted. */
    fun difference(line: Line, counted: Long?): String {
        if (counted == null) return "Not counted"
        val d = line.expectedLeft - counted
        return when { d == 0L -> "Balanced"; d > 0 -> "$d missing"; else -> "${-d} extra" }
    }

    fun parseCount(text: String): Long {
        val t = text.trim()
        require(t.matches(Regex("[0-9]{1,9}"))) { "Enter the counted quantity as a whole number" }
        return t.toLong()
    }

    /** The count op payload; every loaded product must be counted, each difference with a reason. */
    fun payload(week: Week, counts: Map<String, String>, reasons: Map<String, String?>, notes: Map<String, String>): JSONObject {
        require(week.status != "reviewed") { "The office already closed this week" }
        val known = week.reasons.map { it.id }.toSet()
        val lines = JSONArray()
        for (line in week.lines) {
            val counted = parseCount(counts[line.productId] ?: "")
            val reason = reasons[line.productId]?.takeIf { it.isNotBlank() }
            if (needsReason(line, counted)) require(reason != null) { "Choose a reason for ${line.name}" }
            if (reason != null) require(reason in known || reason == line.reasonId) { "Choose a listed reason for ${line.name}" }
            val note = notes[line.productId]?.trim().orEmpty()
            require(note.length <= 300) { "Keep the note for ${line.name} short" }
            lines.put(JSONObject().put("productId", line.productId).put("countedBase", counted)
                .put("reasonId", reason ?: JSONObject.NULL).put("note", note.ifEmpty { JSONObject.NULL }))
        }
        return JSONObject().put("weekId", week.id).put("lines", lines)
    }
}
