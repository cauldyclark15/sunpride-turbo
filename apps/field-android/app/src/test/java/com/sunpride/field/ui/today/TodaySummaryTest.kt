package com.sunpride.field.ui.today

import com.sunpride.field.storage.ProductiveCall
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TodaySummaryTest {
    private fun facts(vararg kinds: String, reason: String? = null) = ProductiveCall.facts(kinds.toList(), reason)
    private fun visit(name: String, status: String = "Scheduled", sequence: Int? = null,
        callFacts: ProductiveCall.Facts? = null, listPosition: Int? = null) = VisitDisplay(name, "Planned", status,
        "o-$name", "p-$name", sequence = sequence, listPosition = listPosition, callFacts = callFacts)
    private fun sales(rule: String?) = DaySalesView(DaySales("2026-10-05", null, 0, null, null, 0, rule))

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

    @Test fun productiveFollowsRecordedActivitiesNotTheEndOutcome() {
        val s = TodaySummary.of(TodayData(listOf(
            visit("A", "Done", 0, facts("order_intent")),
            visit("B", "Done", 1, facts("note")), // completed End with only a note: a call, not productive
            visit("C", "Done", 2, facts("inventory_check", reason = "closed")),
            visit("D", "In progress", 3), visit("E", sequence = 4)), sales = sales(ProductiveCall.ANY_LISTED_ACTIVITY)))
        assertEquals(5, s.planned); assertEquals(3, s.done); assertEquals(2, s.productive)
        assertEquals(66, s.productivePercent) // rounded down like the server's summarizeCalls
        assertEquals(0.6f, s.progress, 0.0001f)
        assertEquals("Productive 2 of 3 finished · 66%", productiveLine(s))
        assertEquals("Not productive", outcomeLabel(s, s.stops[1]))
        assertEquals("D", s.next?.visit?.outlet); assertTrue(s.next!!.inProgress)
        assertFalse(s.allDone)
    }

    @Test fun truckSellerMerchandisingNeedsTheNoSalesMarker() {
        val visits = listOf(visit("A", "Done", 0, facts("merchandising")),
            visit("B", "Done", 1, facts("merchandising", reason = ProductiveCall.NO_SALES_DUE_TO_INVENTORY)))
        val truck = TodaySummary.of(TodayData(visits, sales = sales(ProductiveCall.TRUCK_SELLER)))
        assertEquals(1, truck.productive)
        assertEquals(listOf("Not productive", "Productive"), truck.stops.map { outcomeLabel(truck, it) })
        assertEquals(2, TodaySummary.of(TodayData(visits, sales = sales(ProductiveCall.ANY_LISTED_ACTIVITY))).productive)
        // Rule not known yet (no report fetched): the phone uses the stricter rule and never over-claims.
        assertEquals(1, TodaySummary.of(TodayData(visits)).productive)
    }

    @Test fun openCallWinsOverAnEarlierUnfinishedStop() {
        // A rejected (review) earlier stop does not hide the call the seller is standing in.
        val s = TodaySummary.of(TodayData(listOf(visit("A", "Needs review", 0), visit("B", "In progress", 1))))
        assertEquals("B", s.next?.visit?.outlet)
    }

    @Test fun beforeFirstCallEndsThereIsNoPercent() {
        val s = TodaySummary.of(TodayData(listOf(visit("A"))))
        assertNull(s.productivePercent)
        assertEquals("Productive · no calls ended yet", productiveLine(s))
    }

    @Test fun allDoneHasNoNextStoreAndEmptyDayIsNotDone() {
        val done = TodaySummary.of(TodayData(listOf(visit("A", "Done", 0, facts("merchandising")))))
        assertNull(done.next); assertTrue(done.allDone); assertEquals(1f, done.progress, 0f)
        val empty = TodaySummary.of(TodayData())
        assertFalse(empty.allDone); assertEquals(0f, empty.progress, 0f); assertNull(empty.next)
    }

    @Test fun outcomeLabelOnlyForFinishedCalls() {
        val s = TodaySummary.of(TodayData(listOf(visit("A", "In progress", 0, facts("order_intent")),
            visit("B", "Done", 1))))
        assertNull(outcomeLabel(s, s.stops[0])); assertNull(outcomeLabel(s, s.stops[1]))
    }
}
