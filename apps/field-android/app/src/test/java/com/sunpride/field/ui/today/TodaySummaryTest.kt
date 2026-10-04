package com.sunpride.field.ui.today

import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TodaySummaryTest {
    private fun visit(name: String, status: String = "Scheduled", sequence: Int? = null, outcome: String? = null,
        listPosition: Int? = null) = VisitDisplay(name, "Planned", status, "o-$name", "p-$name",
        sequence = sequence, listPosition = listPosition, outcome = outcome)

    @Test fun stopsFollowPlanOrderAndNumberFromOne() {
        val s = TodaySummary.of(TodayData(listOf(visit("C", sequence = 2), visit("A", sequence = 0),
            visit("B", sequence = 1)), routeCode = "R-07"))
        assertEquals(listOf("A" to 1, "B" to 2, "C" to 3), s.stops.map { it.visit.outlet to it.stop })
        assertEquals("R-07", s.routeCode)
        assertEquals("A", s.next?.visit?.outlet)
    }

    @Test fun missingSequenceKeepsWireListPosition() {
        val s = TodaySummary.of(TodayData(listOf(visit("Z", listPosition = 1), visit("Y", listPosition = 0))))
        assertEquals(listOf("Y", "Z"), s.stops.map { it.visit.outlet })
    }

    @Test fun progressAndProductiveCountOnlyFinishedCalls() {
        val s = TodaySummary.of(TodayData(listOf(
            visit("A", "Done", 0, "completed"), visit("B", "Done", 1, "nonproductive"),
            visit("C", "Done", 2, "completed"), visit("D", "In progress", 3), visit("E", sequence = 4))))
        assertEquals(5, s.planned); assertEquals(3, s.done); assertEquals(2, s.productive)
        assertEquals(67, s.productivePercent)
        assertEquals(0.6f, s.progress, 0.0001f)
        assertEquals("Productive 2 of 3 finished · 67%", productiveLine(s))
        assertEquals("D", s.next?.visit?.outlet); assertTrue(s.next!!.inProgress)
        assertFalse(s.allDone)
    }

    @Test fun openCallWinsOverAnEarlierUnfinishedStop() {
        // A rejected (review) earlier stop does not hide the call the seller is standing in.
        val s = TodaySummary.of(TodayData(listOf(visit("A", "Needs review", 0), visit("B", "In progress", 1))))
        assertEquals("B", s.next?.visit?.outlet)
    }

    @Test fun beforeFirstCallEndsThereIsNoPercentAndNoInventedSales() {
        val s = TodaySummary.of(TodayData(listOf(visit("A"))))
        assertNull(s.productivePercent)
        assertEquals("Productive · no calls ended yet", productiveLine(s))
        assertFalse(s.salesAvailable)
    }

    @Test fun allDoneHasNoNextStoreAndEmptyDayIsNotDone() {
        val done = TodaySummary.of(TodayData(listOf(visit("A", "Done", 0, "completed"))))
        assertNull(done.next); assertTrue(done.allDone); assertEquals(1f, done.progress, 0f)
        val empty = TodaySummary.of(TodayData())
        assertFalse(empty.allDone); assertEquals(0f, empty.progress, 0f); assertNull(empty.next)
    }

    @Test fun outcomeLabelOnlyForFinishedCalls() {
        assertEquals("Productive", outcomeLabel(visit("A", "Done", outcome = "completed")))
        assertEquals("Not productive", outcomeLabel(visit("A", "Done", outcome = "nonproductive")))
        assertNull(outcomeLabel(visit("A", "In progress", outcome = "completed")))
        assertNull(outcomeLabel(visit("A", "Done")))
    }
}
