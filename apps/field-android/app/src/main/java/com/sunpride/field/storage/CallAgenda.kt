package com.sunpride.field.storage

import org.json.JSONObject
import java.time.LocalDate
import java.text.NumberFormat
import java.util.Locale

/** F-203: additive signed-bundle call context lives in the existing encrypted visit snapshot. */
data class CallAgenda(
    val beat: String?, val planVersion: Int, val objectives: List<String>,
    val lastVisit: String?, val arLabel: String, val arSource: String,
    val mslKnown: Boolean, val mslVersion: String?, val mslAsOf: String?,
    val gaps: List<String>, val unmeasured: Int, val required: Int?,
) {
    companion object {
        fun decode(o: JSONObject): CallAgenda {
            fun text(obj: JSONObject, key: String, optional: Boolean = false): String? {
                if (optional && (!obj.has(key) || obj.isNull(key))) return null
                return (obj.get(key) as? String)?.takeIf { it.isNotBlank() && it.length <= 1000 }
                    ?: error("Invalid agenda text")
            }
            fun count(obj: JSONObject, key: String): Int {
                val n = obj.get(key) as? Number ?: error("Invalid agenda count")
                require(n.toDouble().isFinite() && n.toDouble() == n.toLong().toDouble() && n.toLong() in 0..500)
                return n.toInt()
            }
            fun names(key: String, parent: JSONObject): List<String> {
                val a = parent.getJSONArray(key); require(a.length() <= 500)
                return (0 until a.length()).map { text(a.getJSONObject(it), "name")!! }
            }
            val list = o.getJSONArray("objectives"); require(list.length() <= 50)
            val objectives = (0 until list.length()).map { (list.get(it) as? String)?.takeIf { s -> s.isNotBlank() && s.length <= 500 } ?: error("Invalid objective") }
            val last = o.optJSONObject("lastVisit")?.let {
                val date = text(it,"date")!!; LocalDate.parse(date)
                val outcome = when (text(it,"outcome")) {"nonproductive" -> "Nonproductive"; "completed" -> "Completed"; else -> "Outcome awaiting review"}
                "$date · $outcome"
            }
            val ar = o.getJSONObject("ar")
            val arStatus = text(ar,"status")
            val amount = if (ar.isNull("amountMinor")) null else {
                val n = ar.get("amountMinor") as? Number ?: error("Invalid AR amount")
                require(n.toDouble().isFinite() && n.toDouble() == n.toLong().toDouble() && n.toLong() in 0..9_007_199_254_740_991L)
                n.toLong()
            }
            val arLabel = if (arStatus == "sample" && amount != null) {
                val fmt = NumberFormat.getCurrencyInstance(Locale.forLanguageTag("en-PH"))
                "${fmt.format(amount / 100.0)} (sample)"
            } else "Not supplied by SAP"
            val msl = o.getJSONObject("msl")
            val known = text(msl,"status") == "known"
            val gaps = names("gaps",msl)
            val unmeasured = names("unmeasured",msl).size
            val required = if (msl.isNull("requiredCount")) null else count(msl,"requiredCount")
            require(required == null || gaps.size + unmeasured <= required)
            val rawVersion = o.get("planVersion") as? Number ?: error("Invalid plan version")
            require(rawVersion.toDouble().isFinite() && rawVersion.toDouble() == rawVersion.toLong().toDouble() && rawVersion.toLong() in 1..Int.MAX_VALUE.toLong())
            val version = rawVersion.toInt()
            return CallAgenda(text(o,"beat",true), version, objectives, last, arLabel,
                text(ar,"source")!!, known, text(msl,"version",true), text(msl,"asOfDate",true), gaps, unmeasured, required)
        }
    }
}
