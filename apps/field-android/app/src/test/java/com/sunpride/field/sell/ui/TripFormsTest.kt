package com.sunpride.field.sell.ui

import org.junit.Assert.*
import org.junit.Test

/** SP-0192b: a new trip's Count cash must not open with the last trip's counted bills (real-device finding). */
class TripFormsTest {
    private fun typedOn(tripId: String) = TripForms.fresh(tripId).let {
        it.copy(cash = it.cash.copy(pieces = mapOf(100_000L to "3", 50_000L to "2"), reasonCode = "counting_error", note = "short", code = "12345678"),
            stock = it.stock.copy(counts = mapOf(("p1" to "available") to "12")),
            close = it.close.copy(reviewed = true, odometer = "1200"))
    }

    @Test fun aNewTripStartsWithEmptyFormsAndNewIds() {
        val old = typedOn("trip-1")
        val next = old.follow("trip-2")
        assertEquals("trip-2", next.tripId)
        assertTrue(next.cash.pieces.isEmpty())
        assertNull(next.cash.reasonCode)
        assertEquals("", next.cash.note)
        assertEquals("", next.cash.code)
        assertTrue(next.stock.counts.isEmpty())
        assertFalse(next.close.reviewed)
        assertEquals("", next.close.odometer)
        assertNotEquals(old.cash.reconciliationId, next.cash.reconciliationId)
        assertNotEquals(old.stock.reconciliationId, next.stock.reconciliationId)
        assertNotEquals(old.close.closeId, next.close.closeId)
    }

    @Test fun theSameTripKeepsWhatIsTyped() {
        val typed = typedOn("trip-1")
        assertSame(typed, typed.follow("trip-1"))
    }

    @Test fun aMomentWithNoTripKeepsWhatIsTyped() {
        val typed = typedOn("trip-1")
        assertSame(typed, typed.follow(null))
        // ... and the next real trip still clears it.
        assertTrue(typed.follow(null).follow("trip-2").cash.pieces.isEmpty())
    }

    @Test fun theFirstTripTheControllerSeesGetsItsOwnForms() {
        val start = TripForms.fresh(null)
        val first = start.follow("trip-1")
        assertEquals("trip-1", first.tripId)
        assertNotEquals(start.cash.reconciliationId, first.cash.reconciliationId)
    }
}
