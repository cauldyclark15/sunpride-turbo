package com.sunpride.field.location

import org.json.JSONObject
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/**
 * SP-0136 live map: the phone shares its location ONLY during the work day — from the day's first
 * Start (a check-in or the "Start day" button) until "End day", sign-out or the 10 PM Manila daily
 * close, whichever comes first, and never before 05:00. The server refuses field pings outside the
 * same hours (`packages/backend/convex/location/model.ts` LOCATION_POLICY.workStartHour/dailyCloseHour).
 */
object WorkHours {
    val zone: ZoneId = ZoneId.of("Asia/Manila")
    const val START_HOUR = 5
    const val CLOSE_HOUR = 22

    fun serviceDate(ms: Long): String = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate().toString()
    fun within(ms: Long): Boolean = Instant.ofEpochMilli(ms).atZone(zone).hour.let { it in START_HOUR until CLOSE_HOUR }
    /** The 10 PM close of [ms]'s Manila day. */
    fun closeAt(ms: Long): Long = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        .atTime(LocalTime.of(CLOSE_HOUR, 0)).atZone(zone).toInstant().toEpochMilli()
}

/** Why the day stopped; shown nowhere on the server, only used for the phone's own wording. */
enum class EndReason(val code: String) {
    END_DAY("end_day"), SIGN_OUT("sign_out"), DAILY_CLOSE("daily_close");
    companion object { fun of(code: String?) = entries.firstOrNull { it.code == code } }
}

/** Persisted work-day state for one person on this phone. */
data class WorkDayState(val serviceDate: String? = null, val startedAt: Long? = null,
    val endedAt: Long? = null, val endReason: EndReason? = null) {
    val started get() = startedAt != null && endedAt == null

    fun encode(): String = JSONObject().put("serviceDate", serviceDate ?: JSONObject.NULL)
        .put("startedAt", startedAt ?: JSONObject.NULL).put("endedAt", endedAt ?: JSONObject.NULL)
        .put("endReason", endReason?.code ?: JSONObject.NULL).toString()

    companion object {
        fun decode(text: String?): WorkDayState = runCatching {
            val o = JSONObject(text ?: return WorkDayState())
            fun long(key: String) = if (o.isNull(key)) null else o.getLong(key)
            WorkDayState(if (o.isNull("serviceDate")) null else o.getString("serviceDate"),
                long("startedAt"), long("endedAt"), EndReason.of(o.optString("endReason")))
        }.getOrDefault(WorkDayState())
    }
}

class OutsideWorkHours : IllegalStateException("Location sharing runs from 5 AM until the 10 PM daily close.")

object WorkDayRules {
    /** The state as of [now]: a day left running past 10 PM (or into the next day) is closed. */
    fun effective(state: WorkDayState, now: Long): WorkDayState {
        if (!state.started) return state
        val started = state.startedAt!!
        val close = WorkHours.closeAt(started)
        return if (now >= close || WorkHours.serviceDate(now) != state.serviceDate)
            state.copy(endedAt = close, endReason = EndReason.DAILY_CLOSE) else state
    }

    fun tracking(state: WorkDayState, now: Long): Boolean =
        effective(state, now).started && WorkHours.within(now)

    /** "Start day" (or a restart after End day): refused outside 05:00–22:00. */
    fun start(state: WorkDayState, now: Long): WorkDayState {
        if (!WorkHours.within(now)) throw OutsideWorkHours()
        val current = effective(state, now)
        if (current.started) return current
        return WorkDayState(WorkHours.serviceDate(now), now)
    }

    /**
     * The day's first check-in starts sharing. It never overrides the person's own End day earlier
     * the same day: they restart with "Start day" if they are working again.
     */
    fun startOnCheckIn(state: WorkDayState, now: Long): WorkDayState? {
        if (!WorkHours.within(now)) return null
        val current = effective(state, now)
        if (current.started) return null
        val today = WorkHours.serviceDate(now)
        if (current.serviceDate == today && current.endReason == EndReason.END_DAY) return null
        return WorkDayState(today, now)
    }

    fun end(state: WorkDayState, now: Long, reason: EndReason): WorkDayState {
        val current = effective(state, now)
        return if (current.started) current.copy(endedAt = now, endReason = reason) else current
    }
}
