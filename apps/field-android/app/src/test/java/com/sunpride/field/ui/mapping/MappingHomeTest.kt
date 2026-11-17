package com.sunpride.field.ui.mapping

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZonedDateTime

/** SP-0195: the Customer mapping Home counts this person's saves from the phone itself (works offline). */
class MappingHomeTest {
    private val zone = MappingHome.ZONE
    private fun at(y: Int, m: Int, d: Int, h: Int) = ZonedDateTime.of(y, m, d, h, 0, 0, 0, zone).toInstant().toEpochMilli()

    @Test fun countsTodayAndThisWeekInPhilippineTime() {
        // Wednesday 18 Nov 2026, 15:00 Manila. The week started Monday 16 Nov.
        val now = at(2026, 11, 18, 15)
        val saves = listOf(
            MappingSave("A", null, true, at(2026, 11, 18, 0)),   // today, first minute
            MappingSave("B", null, false, at(2026, 11, 18, 14)), // today, waiting
            MappingSave("C", null, true, at(2026, 11, 17, 23)),  // yesterday
            MappingSave("D", null, true, at(2026, 11, 16, 1)),   // Monday
            MappingSave("E", null, true, at(2026, 11, 15, 23)),  // Sunday: last week
        )
        assertEquals(MappingHome.Counts(today = 2, week = 4), MappingHome.counts(saves, now))
        assertEquals(MappingHome.Counts(0, 0), MappingHome.counts(emptyList(), now))
    }

    @Test fun lastFiveNewestFirstWithAPlainState() {
        val saves = (1..7).map { MappingSave("Store $it", "Brgy $it", it % 2 == 0, it * 1000L) }
        val recent = MappingHome.recent(saves)
        assertEquals(listOf("Store 7", "Store 6", "Store 5", "Store 4", "Store 3"), recent.map { it.name })
        assertEquals("Waiting to send", MappingHome.stateLabel(recent[0]))
        assertEquals("Sent", MappingHome.stateLabel(recent[1]))
    }

    // SP-0196: the Customers tab in Customer mapping lists this phone's stores still waiting for the office.
    @Test fun waitingListsUnapprovedStoresNewestFirstAndSearches() {
        val saves = listOf(MappingSave("Aling Nena Sari-Sari Store", "Lahug", true, 3L, owner = "Nena Reyes"),
            MappingSave("Mang Ben Variety Store", "Camputhaw", false, 2L, owner = "Benjamin Cruz"),
            MappingSave("Approved Store", null, true, 4L, accepted = true),
            MappingSave("Refused Store", null, true, 1L, accepted = false))
        assertEquals(listOf("Aling Nena Sari-Sari Store", "Mang Ben Variety Store", "Refused Store"), MappingHome.waiting(saves, "").map { it.name })
        assertEquals(listOf("Mang Ben Variety Store"), MappingHome.waiting(saves, "benjamin").map { it.name })
        assertEquals(listOf("Aling Nena Sari-Sari Store"), MappingHome.waiting(saves, "lahug store").map { it.name })
        assertEquals(listOf("Waiting for approval", "Waiting to send", "Not approved"),
            MappingHome.waiting(saves, "").map(MappingHome::waitingLabel))
    }
}
