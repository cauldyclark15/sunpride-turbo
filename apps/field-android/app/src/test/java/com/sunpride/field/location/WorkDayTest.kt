package com.sunpride.field.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertThrows
import org.junit.Test
import java.time.ZonedDateTime

class WorkDayTest {
    private fun at(day: Int, hour: Int, minute: Int = 0) =
        ZonedDateTime.of(2026, 10, day, hour, minute, 0, 0, WorkHours.zone).toInstant().toEpochMilli()

    @Test fun workHoursMatchTheServerWindow() {
        assertFalse(WorkHours.within(at(8, 4, 59)))
        assertTrue(WorkHours.within(at(8, 5)))
        assertTrue(WorkHours.within(at(8, 21, 59)))
        assertFalse(WorkHours.within(at(8, 22)))
        assertEquals(at(8, 22), WorkHours.closeAt(at(8, 9)))
        assertEquals("2026-10-08", WorkHours.serviceDate(at(8, 23, 59)))
    }

    @Test fun startDayIsRefusedOutsideWorkHours() {
        assertThrows(OutsideWorkHours::class.java) { WorkDayRules.start(WorkDayState(), at(8, 4)) }
        assertThrows(OutsideWorkHours::class.java) { WorkDayRules.start(WorkDayState(), at(8, 22, 5)) }
        val started = WorkDayRules.start(WorkDayState(), at(8, 7))
        assertTrue(started.started); assertEquals("2026-10-08", started.serviceDate)
        // Starting again keeps the original start.
        assertEquals(started, WorkDayRules.start(started, at(8, 9)))
    }

    @Test fun theDailyCloseStopsADayLeftRunning() {
        val started = WorkDayRules.start(WorkDayState(), at(8, 7))
        assertTrue(WorkDayRules.tracking(started, at(8, 21, 59)))
        assertFalse(WorkDayRules.tracking(started, at(8, 22)))
        val closed = WorkDayRules.effective(started, at(8, 22, 30))
        assertEquals(EndReason.DAILY_CLOSE, closed.endReason); assertEquals(at(8, 22), closed.endedAt)
        // The next morning nothing is shared until a new Start.
        assertFalse(WorkDayRules.tracking(started, at(9, 8)))
        assertFalse(WorkDayRules.effective(started, at(9, 8)).started)
    }

    @Test fun firstCheckInStartsTheDayButNeverOverridesEndDay() {
        val auto = WorkDayRules.startOnCheckIn(WorkDayState(), at(8, 8))
        assertNotNull(auto); assertTrue(auto!!.started)
        assertNull("already running", WorkDayRules.startOnCheckIn(auto, at(8, 9)))
        val ended = WorkDayRules.end(auto, at(8, 12), EndReason.END_DAY)
        assertNull("End day is respected", WorkDayRules.startOnCheckIn(ended, at(8, 13)))
        assertNotNull("a new day starts again", WorkDayRules.startOnCheckIn(ended, at(9, 8)))
        val signedOut = WorkDayRules.end(auto, at(8, 12), EndReason.SIGN_OUT)
        assertNotNull("signing back in and starting a visit resumes", WorkDayRules.startOnCheckIn(signedOut, at(8, 13)))
        assertNull("never before 5 AM", WorkDayRules.startOnCheckIn(WorkDayState(), at(8, 4)))
    }

    @Test fun stateRoundTripsThroughStorage() {
        val state = WorkDayState("2026-10-08", at(8, 7), at(8, 12), EndReason.END_DAY)
        assertEquals(state, WorkDayState.decode(state.encode()))
        assertEquals(WorkDayState(), WorkDayState.decode("not json"))
        assertEquals(WorkDayState(), WorkDayState.decode(null))
    }

    private class MapPrefs : WorkDayPrefs {
        val map = mutableMapOf<String, String>()
        override fun get(key: String) = map[key]
        override fun put(key: String, value: String?) { if (value == null) map.remove(key) else map[key] = value }
    }
    private class Service : LocationService {
        var running = false; var starts = 0; var stops = 0
        override fun start() { running = true; starts++ }
        override fun stop() { running = false; stops++ }
    }

    @Test fun hostNeedsConsentAndPermissionAndStopsOnEndDayAndSignOut() {
        val prefs = MapPrefs(); val service = Service()
        var account: String? = "https://issuer|ana"
        var perms = LocationPermissions(location = true, background = false)
        val day = WorkDay(prefs, { account }, { perms }, service)
        val t = at(8, 8)
        assertTrue(day.view(t).available); assertFalse(day.view(t).consented)
        // Without consent neither Start day nor a check-in records anything.
        assertThrows(IllegalStateException::class.java) { day.startDay(t) }
        day.onCheckIn(t)
        assertFalse(day.view(t).started); assertEquals(0, service.starts)

        day.consent(t)
        day.onCheckIn(t)
        assertTrue(day.view(t).sharing); assertTrue(service.running); assertTrue(day.tracking(t))
        assertEquals("Location sharing on", com.sunpride.field.ui.location.WorkDayCopy.indicator(day.view(t)))

        // Permission revoked in Settings: the day still runs but the phone says "Location off".
        perms = LocationPermissions(location = false, background = false)
        assertTrue(day.view(t).started); assertFalse(day.view(t).sharing); assertFalse(day.tracking(t))
        assertEquals("Location off", com.sunpride.field.ui.location.WorkDayCopy.indicator(day.view(t)))
        perms = LocationPermissions(location = true, background = true)

        day.endDay(at(8, 17))
        assertFalse(service.running); assertFalse(day.view(at(8, 17)).started)
        assertEquals(EndReason.END_DAY, day.view(at(8, 17)).endReason)
        day.onCheckIn(at(8, 18))
        assertFalse("check-in after End day does not restart", day.view(at(8, 18)).started)

        day.startDay(at(8, 18))
        assertTrue(service.running)
        day.signOut(at(8, 19))
        assertFalse(service.running); assertFalse(day.tracking(at(8, 19)))

        // A different person on the same phone gives their own consent.
        account = "https://issuer|ben"
        assertFalse(day.view(at(8, 19)).consented)
        assertFalse(day.view(at(8, 19)).started)
        account = null
        assertFalse(day.view(at(8, 19)).available)
    }

    @Test fun resumeOnlyRestartsARunningDayAndNeverAfterTheClose() {
        val service = Service()
        val day = WorkDay(MapPrefs(), { "acct" }, { LocationPermissions(true, false) }, service)
        day.resume(at(8, 8)); assertEquals(0, service.starts)
        day.consent(at(8, 8)); day.startDay(at(8, 8)); assertEquals(1, service.starts)
        day.resume(at(8, 9)); assertEquals(2, service.starts)
        day.resume(at(8, 22, 1)); assertEquals(2, service.starts)
        day.closeIfDue(at(8, 22, 1))
        assertEquals(EndReason.DAILY_CLOSE, day.state().endReason)
        assertEquals("Location sharing runs from 5 AM until the 10 PM close",
            com.sunpride.field.ui.location.WorkDayCopy.status(day.view(at(8, 22, 1))))
    }

    @Test fun permissionRequestAddsNotificationsOnlyOnAndroid13() {
        assertEquals(2, com.sunpride.field.ui.location.LocationPermissionRequest.permissions(32).size)
        assertTrue(com.sunpride.field.ui.location.LocationPermissionRequest.permissions(33)
            .contains("android.permission.POST_NOTIFICATIONS"))
    }
}
