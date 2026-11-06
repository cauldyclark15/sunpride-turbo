package com.sunpride.van.scanning

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** IP-HH1: wedge burst detection, the shared duplicate filter and the router between them. */
class ScannerInputTest {
    private fun feed(detector: WedgeBurstDetector, text: String, start: Long, gap: Long): Pair<String?, Long> {
        var t = start; var out: String? = null
        text.forEach { out = detector.accept(it, t) ?: out; t += gap }
        return out to (t - gap)
    }

    @Test fun aFastBurstEndedByEnterIsOneScan() {
        val d = WedgeBurstDetector()
        val (_, last) = feed(d, "4800000000017", 1_000, 8)
        assertEquals("4800000000017", d.accept('\n', last + 10))
        assertFalse(d.hasPending)
    }

    @Test fun aFastBurstEndedByASilenceOf50msIsOneScan() {
        val d = WedgeBurstDetector()
        val (_, last) = feed(d, "SP-PJ-1L", 1_000, 10)
        assertNull("not yet: still inside the gap", d.idleFlush(last + 49))
        assertEquals("SP-PJ-1L", d.idleFlush(last + 50))
        assertNull("flushed once only", d.idleFlush(last + 400))
    }

    @Test fun humanTypingIsNeverAScan() {
        val d = WedgeBurstDetector()
        val (_, last) = feed(d, "4800000000017", 1_000, 120)
        assertNull(d.accept('\n', last + 120))
        feed(d, "abcd", 5_000, 120)
        assertNull(d.idleFlush(9_000))
    }

    @Test fun aRunShorterThanTheMinimumIsDropped() {
        val d = WedgeBurstDetector(minLength = 4)
        feed(d, "123", 0, 5)
        assertNull(d.accept('\n', 20))
    }

    @Test fun aSlowGapInsideARunRestartsIt() {
        val d = WedgeBurstDetector()
        feed(d, "9999", 0, 5)
        val (_, last) = feed(d, "48000000", 1_000, 5) // 1 s later: the first four were typing
        assertEquals("48000000", d.accept('\n', last + 5))
    }

    @Test fun anOversizedBurstIsRejectedWholeNotTruncated() {
        val d = WedgeBurstDetector(maxLength = 8)
        val (_, last) = feed(d, "123456789012", 0, 2)
        assertNull(d.accept('\n', last + 2))
        val (_, l2) = feed(d, "55555", 1_000, 2)
        assertEquals("55555", d.accept('\n', l2 + 2))
    }

    @Test fun routerSubmitsBurstsToTheSharedGateAndLetsALoneEnterThrough() = runBlocking {
        val inputs = BarcodeInputs(clock = { 10_000L })
        val router = WedgeRouter(inputs)
        assertFalse("Enter with nothing buffered belongs to the screen", router.onCharacter('\n', 5))
        val first = async(start = CoroutineStart.UNDISPATCHED) { inputs.scans.first() }
        "4800000000017".forEachIndexed { i, ch -> assertTrue(router.onCharacter(ch, 100L + i * 5)) }
        assertTrue(router.onCharacter('\n', 200))
        val event = first.await()
        assertEquals("4800000000017", event.code); assertEquals(ScanSource.WEDGE, event.source)
    }

    @Test fun idleFlushThroughTheRouterAlsoScans() = runBlocking {
        val inputs = BarcodeInputs(clock = { 10_000L })
        val router = WedgeRouter(inputs)
        val first = async(start = CoroutineStart.UNDISPATCHED) { inputs.scans.first() }
        "4800000000024".forEachIndexed { i, ch -> router.onCharacter(ch, 100L + i * 4) }
        router.onIdle(100L + 12 * 4 + 50)
        assertEquals("4800000000024", first.await().code)
    }

    @Test fun theBroadcastAndItsTypedCopyAddOnlyOnce() {
        var clock = 1_000L
        val inputs = BarcodeInputs(clock = { clock })
        val router = WedgeRouter(inputs)
        assertNotNull(inputs.submit("4800000000017", ScanSource.BROADCAST))
        clock += 120
        "4800000000017".forEachIndexed { i, ch -> router.onCharacter(ch, 2_000L + i) }
        router.onCharacter('\n', 2_020)
        // The wedge copy arrived 120 ms after the broadcast: dropped by the one 300 ms filter, so no second event.
        assertNull(inputs.submit("4800000000017", ScanSource.WEDGE))
        clock += 400
        assertNotNull("a real second scan after 300 ms counts", inputs.submit("4800000000017", ScanSource.BROADCAST))
    }

    @Test fun theDuplicateFilterIsSharedByEverySource() {
        var clock = 0L
        val inputs = BarcodeInputs(clock = { clock })
        assertNotNull(inputs.submit("123456789012", ScanSource.BROADCAST))
        clock = 299
        assertNull(inputs.cameraCode("123456789012"))
        clock = 300
        assertNotNull(inputs.cameraCode("123456789012"))
    }
}
