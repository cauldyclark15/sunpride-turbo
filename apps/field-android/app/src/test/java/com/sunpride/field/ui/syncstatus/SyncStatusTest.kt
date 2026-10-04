package com.sunpride.field.ui.syncstatus

import com.sunpride.field.storage.OutboxRow
import com.sunpride.field.storage.PartitionRow
import org.junit.Assert.*
import org.junit.Test

class SyncStatusTest {
    private val partition = PartitionRow("account", "device", "scope", activeGeneration = "generation",
        leaseExpiresAt = 2000, cacheExpiresAt = 1500, syncHealth = "synced", lastSuccessfulSync = 1000)
    private fun row(state: String, scope: String = "scope", code: String? = null) =
        OutboxRow("account", "device", scope, "$state-$scope", 1, state, code)

    @Test fun everyUnresolvedStatePreventsAllSynced() {
        for (state in listOf("pending", "sending", "review")) {
            val status = SyncStatus.fromRoom(partition, listOf(row(state)))
            assertNotEquals("All synced", status.label(1100))
            assertTrue(status.pending)
        }
        val held = SyncStatus.fromRoom(partition, listOf(row("pending", "old-scope")))
        assertEquals(1, held.held)
        assertNotEquals("All synced", held.label(1100))
        assertEquals("All synced", SyncStatus.fromRoom(partition, emptyList()).label(1100))
    }

    @Test fun closeBoundaryAndLateOldServiceDaysUseManilaNotUtc() {
        val before = java.time.Instant.parse("2026-10-02T13:59:59.999Z").toEpochMilli()
        val close = java.time.Instant.parse("2026-10-02T14:00:00Z").toEpochMilli()
        val nextMorning = java.time.Instant.parse("2026-10-03T01:00:00Z").toEpochMilli()
        assertEquals(close, dayClose("2026-10-02"))
        val pending = SyncStatus(queued = 1, earliestUnsentCloseAt = close)
        assertEquals("Sync before 10 PM", pending.label(before))
        assertEquals("Late · held for review", pending.label(close))
        assertEquals("Late · held for review", pending.label(nextMorning))
        assertEquals("Held · needs review", pending.copy(held = 1).label(close))
        assertEquals("Needs review · not synced", pending.copy(review = 1).label(close))
        assertEquals("Sync before 10 PM", pending.copy(offline = true).label(before))
        assertTrue(closeTime(close).contains("10:00 PM · Asia/Manila"))
        assertEquals("Finish the open call first", SyncStatus.plainReason("call_open"))
        assertEquals("Visit stores in plan order", SyncStatus.plainReason("mcp_order"))
    }
    @Test fun dependentWorkUsesCheckInServiceDayEvenIfEndQueuedNextMorning() {
        val scope = com.sunpride.field.storage.StoreScope("account", "device", "scope")
        val startAt = java.time.Instant.parse("2026-10-02T13:00:00Z").toEpochMilli()
        val endAt = java.time.Instant.parse("2026-10-03T01:00:00Z").toEpochMilli()
        val start = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, "visit.checkIn", null, null, null,
            "p", "o", emptyList(), null, null, null, null, null, startAt)
        val end = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, "visit.checkOut", start.clientVisitId,
            start.requestId, start.requestId, "p", "o", emptyList(), null, null, "completed", null, null, endAt)
        val status = SyncStatus.fromRoom(partition, listOf(OutboxRow("account", "device", "scope", end.requestId, endAt)),
            intents = listOf(start, end))
        assertEquals(dayClose("2026-10-02"), status.earliestUnsentCloseAt)
        assertEquals("Late · held for review", status.label(endAt))
    }
    @Test fun countsAndExpiryAreRoomDerived() {
        val rows = listOf(row("pending"), row("sending"), row("review", code = "conflict"), row("pending", "old-scope"))
        val status = SyncStatus.fromRoom(partition, rows)
        assertEquals(1, status.queued)
        assertEquals(1, status.sending)
        assertEquals(1, status.review)
        assertEquals(1, status.held)
        assertEquals(listOf("Server reported a conflict"), status.reviewReasons)
        assertFalse(status.leaseExpired(1999))
        assertTrue(status.leaseExpired(2000))
        assertTrue(status.cacheStale(1500))
        assertFalse(status.cacheStale(1499))
        assertEquals("Offline · saved data", SyncStatus.fromRoom(partition, emptyList(), offline = true).label(1100))
        assertEquals("Visit needs administrator review", SyncStatus.plainReason("name: any private value"))
    }
}
