package com.sunpride.van.pos

import org.junit.Assert.*
import org.junit.Test

class SplitTenderTest {
    @Test fun theBalanceIsLiveAndChangeOnlyComesFromCash() {
        val v = SplitTenders.view(10_000, 3_000, 5_000)
        assertEquals(7_000L, v.cashDueMinor); assertEquals(2_000L, v.remainingMinor); assertEquals(0L, v.changeMinor); assertFalse(v.ready)
        val done = SplitTenders.view(10_000, 3_000, 10_000)
        assertEquals(0L, done.remainingMinor); assertEquals(3_000L, done.changeMinor); assertTrue(done.ready)
        assertEquals(0L, SplitTenders.view(10_000, 3_000, 7_000).changeMinor)
    }
    @Test fun theOtherTenderMustLeaveSomethingForCash() {
        assertTrue(SplitTenders.partsValid(10_000, 1)); assertTrue(SplitTenders.partsValid(10_000, 9_999))
        assertFalse(SplitTenders.partsValid(10_000, 0)); assertFalse(SplitTenders.partsValid(10_000, 10_000)); assertFalse(SplitTenders.partsValid(10_000, -5)); assertFalse(SplitTenders.partsValid(1, 1))
        assertEquals(0L, SplitTenders.view(10_000, 99_999, 0).cashDueMinor)
    }
}
