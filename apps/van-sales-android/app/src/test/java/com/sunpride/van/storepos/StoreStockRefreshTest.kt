package com.sunpride.van.storepos

import org.junit.Assert.*
import org.junit.Test

class StoreStockRefreshTest {
    @Test fun entersTheGridAndRefreshesAtOnce() = assertTrue(StoreStockRefresh.due(null, 1_000, busy = false, inFlight = false))
    @Test fun thenOncePerMinute() {
        assertFalse(StoreStockRefresh.due(1_000, 30_000, busy = false, inFlight = false))
        assertTrue(StoreStockRefresh.due(1_000, 61_000, busy = false, inFlight = false))
    }
    @Test fun neverWhileSavingOrWhileOneIsRunning() {
        assertFalse(StoreStockRefresh.due(null, 1_000, busy = true, inFlight = false))
        assertFalse(StoreStockRefresh.due(null, 1_000, busy = false, inFlight = true))
    }
    @Test fun aClockSetBackDoesNotStopTheRefresh() = assertTrue(StoreStockRefresh.due(100_000, 50_000, busy = false, inFlight = false))
}
