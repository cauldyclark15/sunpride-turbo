package com.sunpride.van.scanning

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class WedgeBufferTest {
    @Test fun assemblesCharactersUntilEnter() {
        val buffer = WedgeBuffer()
        "4800000000017".forEachIndexed { index, char -> assertNull(buffer.accept(char, index * 10L)) }
        assertEquals("4800000000017", buffer.accept('\n', 140))
        assertNull(buffer.accept('\n', 150))
    }
    @Test fun staleBurstIsDiscardedAndBackspaceWorks() {
        val buffer = WedgeBuffer(timeoutMillis = 100)
        buffer.accept('a', 0)
        buffer.accept('b', 200)
        buffer.accept('x', 210)
        buffer.accept('\b', 220)
        assertEquals("b", buffer.accept('\r', 230))
    }
    @Test fun overflowRejectsTheWholeScanNotATruncatedCode() {
        val buffer = WedgeBuffer(maxLength = 3)
        "abcdef".forEachIndexed { i, c -> buffer.accept(c, i.toLong()) }
        assertNull(buffer.accept('\n', 10))
        buffer.accept('z', 20)
        assertEquals("z", buffer.accept('\n', 30))
    }
    @Test fun expiredEnterAndResetDoNotEmit() {
        val buffer = WedgeBuffer(timeoutMillis = 100)
        buffer.accept('a', 0)
        assertNull(buffer.accept('\n', 101))
        buffer.accept('b', 102)
        buffer.reset()
        assertNull(buffer.accept('\n', 103))
    }
    @Test fun dedupesSameCodeAcrossSourcesButAllowsNewScans() {
        var clock = 100L
        val inputs = BarcodeInputs(clock = { clock })
        assertEquals(ScanSource.BROADCAST, inputs.submit("123", ScanSource.BROADCAST)?.source)
        clock = 150
        assertNull(inputs.submit("123", ScanSource.WEDGE))
        assertNotNull(inputs.submit("456", ScanSource.CAMERA))
        clock = 399
        assertNull(inputs.submit("123", ScanSource.CAMERA))
        clock = 400
        assertNotNull(inputs.submit("123", ScanSource.WEDGE))
        assertNull(inputs.submit("", ScanSource.BROADCAST))
    }
    @Test fun duplicateOfEarlierCodeIsStillSuppressedAfterAnotherCode() {
        val dedupe = ScanDeduplicator()
        assertTrue(dedupe.accept("A", 0))
        assertTrue(dedupe.accept("B", 10))
        assertFalse(dedupe.accept("A", 20))
        assertTrue(dedupe.accept("A", 300))
    }
    @Test fun flowExposesUnifiedEventsAndPreservesIdentifierSpaces() = runBlocking {
        val inputs = BarcodeInputs(clock = { 1234 })
        val scan = async(start = CoroutineStart.UNDISPATCHED) { inputs.scans.first() }
        inputs.cameraCode(" abc \r\n")
        assertEquals(ScanEvent(" abc ", ScanSource.CAMERA, 1234), scan.await())
    }
    @Test fun wedgeAndBroadcastShareOneDedupeWindow() {
        val inputs = BarcodeInputs(clock = { 100 })
        "123".forEachIndexed { index, c -> inputs.wedgeCharacter(c, index.toLong()) }
        assertEquals(ScanSource.WEDGE, inputs.wedgeCharacter('\n', 5)?.source)
        assertNull(inputs.submit("123", ScanSource.BROADCAST))
    }
}
