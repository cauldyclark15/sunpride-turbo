package com.sunpride.field.location

import java.security.MessageDigest

/** What the Today card and the top-bar indicator show. */
data class WorkDayView(
    /** A synced person is signed in on this phone (pings have a partition to live in). */
    val available: Boolean = false,
    /** The one-time consent screen was accepted by this person on this phone. */
    val consented: Boolean = false,
    /** The work day is running (Start day / first check-in, before End day / 10 PM). */
    val started: Boolean = false,
    /** Started AND location permission is on: the phone is recording pings now. */
    val sharing: Boolean = false,
    val locationAllowed: Boolean = false,
    val backgroundAllowed: Boolean = false,
    val withinHours: Boolean = true,
    val startedAt: Long? = null,
    val endReason: EndReason? = null,
)

/** Started by "Start day" / a check-in and stopped by End day / sign-out / 10 PM. */
interface WorkDayHost {
    fun view(now: Long): WorkDayView
    fun consent(now: Long)
    /** Throws [OutsideWorkHours] before 5 AM or after the 10 PM close. Needs consent. */
    fun startDay(now: Long)
    fun endDay(now: Long)
    /** A visit Start was queued: begin the day's sharing if this person consented. */
    fun onCheckIn(now: Long)
    /** Sign-out always stops sharing first. */
    fun signOut(now: Long)
    /** App opened / permission granted later: (re)start the service if the day is running. */
    fun resume(now: Long)
}

/** Small persisted key/value seam (SharedPreferences on the phone, a map in JVM tests). */
interface WorkDayPrefs {
    fun get(key: String): String?
    fun put(key: String, value: String?)
}

/** Starts/stops the foreground location service. */
interface LocationService {
    fun start()
    fun stop()
}

/** Phone permission state, read fresh each time (the person can change it in Settings at any moment). */
data class LocationPermissions(val location: Boolean, val background: Boolean)

/**
 * The work-day rules bound to one person's persisted state. Consent and the day are keyed by a hash
 * of the signed-in account, so a second person on the same phone gives their own consent.
 */
class WorkDay(private val prefs: WorkDayPrefs, private val account: () -> String?,
    private val permissions: () -> LocationPermissions, private val service: LocationService) : WorkDayHost {

    private fun key(): String? = account()?.let { id ->
        MessageDigest.getInstance("SHA-256").digest(id.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it.toInt() and 255) }.take(32)
    }
    fun state(): WorkDayState = key()?.let { WorkDayState.decode(prefs.get("day.$it")) } ?: WorkDayState()
    private fun save(state: WorkDayState) { key()?.let { prefs.put("day.$it", state.encode()) } }
    private fun consented(): Boolean = key()?.let { prefs.get("consent.$it") != null } ?: false

    /** True while pings should be recorded (the service checks this on every fix and tick). */
    fun tracking(now: Long): Boolean = consented() && WorkDayRules.tracking(state(), now) && permissions().location

    override fun view(now: Long): WorkDayView {
        if (key() == null) return WorkDayView()
        val state = WorkDayRules.effective(state(), now)
        val perms = permissions()
        val started = state.started && WorkHours.within(now)
        return WorkDayView(available = true, consented = consented(), started = started,
            sharing = started && consented() && perms.location, locationAllowed = perms.location,
            backgroundAllowed = perms.background, withinHours = WorkHours.within(now),
            startedAt = state.startedAt.takeIf { started }, endReason = state.endReason)
    }

    override fun consent(now: Long) { key()?.let { prefs.put("consent.$it", now.toString()) } }

    override fun startDay(now: Long) {
        check(key() != null) { "Sync first" }
        check(consented()) { "Consent required" }
        save(WorkDayRules.start(state(), now))
        if (permissions().location) service.start()
    }

    override fun endDay(now: Long) {
        save(WorkDayRules.end(state(), now, EndReason.END_DAY))
        service.stop()
    }

    override fun onCheckIn(now: Long) {
        if (key() == null || !consented()) return
        val next = WorkDayRules.startOnCheckIn(state(), now)
        if (next != null) save(next)
        if (WorkDayRules.tracking(state(), now) && permissions().location) service.start()
    }

    override fun signOut(now: Long) {
        if (key() != null) save(WorkDayRules.end(state(), now, EndReason.SIGN_OUT))
        service.stop()
    }

    override fun resume(now: Long) { if (tracking(now)) service.start() }

    /** The service found the day over (10 PM or a new day): persist the close. */
    fun closeIfDue(now: Long) {
        val state = state()
        val effective = WorkDayRules.effective(state, now)
        if (effective != state) save(effective)
    }
}
