package com.sunpride.field.orders

import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit

/** F-301: offline preview of the server's effective Manila cutoff; no second call engine. */
object PresellDates {
    fun validate(flow: JSONObject?, requested: String?, at: Long) {
        val presell = flow?.getJSONObject("definition")?.optString("channelProfile") == "pre_sell"
        if (!presell && requested == null) return
        require(!requested.isNullOrBlank()) { "Choose the requested delivery day." }
        val date = LocalDate.parse(requested)
        require(date.toString() == requested) { "Use a real YYYY-MM-DD delivery date." }
        val policy = flow?.optJSONObject("deliveryPolicy")
        // A missing policy cannot silently authorize a pre-sell promise offline.
        if (presell) requireNotNull(policy) { "Sync the delivery policy first." }
        val local = Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Manila"))
        if (policy != null) {
            val minimum = policy.getInt("lead_days") + if(local.hour*60+local.minute >= policy.getInt("cutoff_minute")) 1 else 0
            val days = ChronoUnit.DAYS.between(local.toLocalDate(), date)
            require(days in minimum.toLong()..policy.getInt("horizon_days").toLong()) { "Delivery is outside the cached cutoff and lead-time rules." }
        } else require(date >= local.toLocalDate()) { "Delivery cannot be before the order day." }
    }
}
