package com.sunpride.field.ui.incentives

import org.json.JSONObject
import java.math.BigDecimal
import java.text.NumberFormat
import java.util.Locale

data class EarnedMetric(val name: String, val actual: String, val target: String, val amountMinor: Long, val excluded: Boolean)
data class EarnedStatement(val name: String, val period: String, val status: String, val amountMinor: Long, val sample: Boolean, val metrics: List<EarnedMetric>)

object EarnedStatements {
    const val PATH = "/api/v1/account/incentives"
    fun money(minor: Long): String = NumberFormat.getCurrencyInstance(Locale.forLanguageTag("en-PH"))
        .format(BigDecimal.valueOf(minor, 2))
    private fun exact(o: JSONObject, key: String): Long {
        val value = o.get(key).toString()
        require(value.matches(Regex("-?[0-9]+")))
        return value.toLong().also { require(it >= 0) }
    }
    fun decode(body: JSONObject): List<EarnedStatement> {
        val rows = body.getJSONArray("rows")
        require(rows.length() <= 500)
        return (0 until rows.length()).map { index ->
            val row = rows.getJSONObject(index)
            val lines = row.getJSONObject("result").getJSONArray("lines")
            require(lines.length() <= 6)
            EarnedStatement(row.getString("plan_name"),
                row.getString("period_from").take(10) + " → " + row.getString("period_to").take(10),
                row.getString("status").replace('_', ' '), exact(row, "amountCentavos"), row.optString("plan_source") == "sample",
                (0 until lines.length()).map { n ->
                    val line = lines.getJSONObject(n)
                    EarnedMetric(line.getString("metric"), if (line.isNull("actual")) "Unknown" else line.get("actual").toString(),
                        if (line.isNull("target")) "Unknown" else line.get("target").toString(), exact(line, "amountCentavos"), line.optBoolean("excluded"))
                })
        }
    }
}
