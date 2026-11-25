package com.sunpride.integrity

import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Deterministic scheduler checks, not Android service/OS delivery evidence. Both products run these. */
class PhoneSupportLoopTest {
    @Test fun checksImmediatelyAndEachMinuteWithoutAnActivityOrPendingUploads() = runBlocking {
        var now = 0L
        val checks = mutableListOf<Long>()
        PhoneSupportLoop.run({ checks.size < 3 }, { true }, { checks += now }, clock = { now }, wait = { now += it })
        assertEquals(listOf(0L, 60_000L, 120_000L), checks)
    }
    @Test fun requestTimeCountsTowardTheMinuteAndChecksNeverOverlap() = runBlocking {
        var now = 0L
        var active = false
        val checks = mutableListOf<Long>()
        PhoneSupportLoop.run({ checks.size < 3 }, { true }, {
            assertFalse(active); active = true; checks += now; now += 20_000; active = false
        }, clock = { now }, wait = { now += it })
        assertEquals(listOf(0L, 60_000L, 120_000L), checks)
    }
    @Test fun anOfflineTickAndFailedCheckDoNotStopLaterDelivery() = runBlocking {
        var now = 0L
        var attempts = 0
        var completed = 0
        val checks = mutableListOf<Long>()
        PhoneSupportLoop.run({ completed == 0 }, { now > 0 }, {
            checks += now
            if (++attempts == 1) throw IOException("SAMPLE offline")
        }, { completed++ }, clock = { now }, wait = { now += it })
        assertEquals(listOf(60_000L, 120_000L), checks)
        assertEquals(1, completed)
    }
    @Test fun reconnectCanWakeBeforeTheNextMinute() = runBlocking {
        var now = 0L
        var online = false
        var checks = 0
        PhoneSupportLoop.run({ checks == 0 }, { online }, { checks++ }, clock = { now }, wait = {
            assertEquals(60_000L, it)
            now += 3_000 // stand-in for ConnectivityManager waking the conflated channel
            online = true
        })
        assertEquals(3_000L, now)
        assertEquals(1, checks)
    }
    @Test fun receiptOnlyRecoveryContinuesAfterLocalSignOutThenStops() = runBlocking {
        var signedIn = true
        var receipt = false
        var checks = 0
        PhoneSupportLoop.run({ signedIn || receipt }, { true }, {
            checks++
            if (signedIn) { signedIn = false; receipt = true } else receipt = false
        }, wait = {})
        assertEquals(2, checks)
    }
    @Test fun signedOutWithoutReceiptsDoesNotPollOrWait() = runBlocking {
        PhoneSupportLoop.run({ false }, { fail("No network inspection needed"); false },
            { fail("No authenticated check") }, wait = { fail("No idle signed-out service") })
    }
    @Test fun cancellationIsNotRetriedOrReportedAsACompletedCheck() = runBlocking {
        var completed = false
        var cancelled = false
        try {
            PhoneSupportLoop.run({ true }, { true }, { throw CancellationException("SAMPLE stopped") },
                { completed = true }, wait = { fail("Must not retry cancellation") })
        } catch (_: CancellationException) { cancelled = true }
        assertTrue(cancelled); assertFalse(completed)
    }
    @Test fun aSlowRequestNeverTurnsTheLoopIntoABusySpin() = runBlocking {
        var now = 0L
        var checks = 0
        PhoneSupportLoop.run({ checks < 2 }, { true }, { checks++; now += 90_000 },
            clock = { now }, wait = { assertEquals(1_000L, it); now += it })
        assertEquals(181_000L, now)
    }
}
