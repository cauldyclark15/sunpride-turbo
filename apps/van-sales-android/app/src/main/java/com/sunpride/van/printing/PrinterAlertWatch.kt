package com.sunpride.van.printing

/**
 * VAN-002: the H10P printer service has no paper query in its AIDL. When paper is out it shows its own system
 * dialog ("Printer Error / Paper is not ready") after accepting the job. That dialog takes the window focus from
 * this app, so a focus loss right after a print is the service telling us the job did not print.
 * MainActivity feeds focus changes; the Senraise adapter asks after each job.
 */
object PrinterAlertWatch {
    @Volatile private var lostAt: Long = Long.MIN_VALUE

    fun focusChanged(hasFocus: Boolean, now: Long) { if (!hasFocus) lostAt = now }

    /** True when the app lost the window focus at or after [start]. */
    fun alertedSince(start: Long): Boolean = lostAt >= start

    /**
     * Waits up to [windowMillis] after a job for the service's own alert. Returns true as soon as one is seen.
     * [clock] and [pause] are injectable for tests.
     */
    suspend fun awaitAlert(start: Long, windowMillis: Long, clock: () -> Long, pause: suspend (Long) -> Unit, stepMillis: Long = 100): Boolean {
        while (true) {
            if (alertedSince(start)) return true
            if (clock() - start >= windowMillis) return false
            pause(stepMillis)
        }
    }

    internal fun resetForTest() { lostAt = Long.MIN_VALUE }
}
