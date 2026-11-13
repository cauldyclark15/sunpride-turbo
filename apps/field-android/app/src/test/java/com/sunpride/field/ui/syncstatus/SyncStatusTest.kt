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

    // FLD-153: held work always carries a plain reason, never a bare count.
    @Test fun heldWorkExplainsItselfInPlainWords() {
        val earlier = SyncStatus.fromRoom(partition, listOf(row("pending", "old-scope")))
        assertEquals(listOf(SyncStatus.HELD_EARLIER), earlier.heldReasons)
        val access = SyncStatus.fromRoom(partition.copy(held = true), listOf(row("pending")))
        assertEquals(1, access.held)
        assertEquals(listOf(SyncStatus.HELD_ACCESS), access.heldReasons)
        assertTrue(SyncStatus.fromRoom(partition, listOf(row("pending"))).heldReasons.isEmpty())
        (earlier.heldReasons + access.heldReasons).forEach { assertFalse(it.contains('_')) }
    }

    // E2E-001: right after registration (never synced, 07:15) the pill must not claim the day is closed.
    @Test fun `E2E-001 never synced phone says sync to start, not day closed`() {
        val fresh = SyncStatus.fromRoom(null, emptyList())
        assertEquals(SyncStatus.NEVER_SYNCED, fresh.label(1100))
        assertFalse(fresh.label(1100).contains("Day closed"))
        // After a sync whose lease lapsed, the day really is closed.
        assertEquals("Day closed · sync for access", SyncStatus.fromRoom(partition, emptyList()).label(2500))
    }

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
        // Offline is said out loud, with the deadline kept, so "Sync now" doing nothing is never a mystery.
        assertEquals("Offline · sync before 10 PM", pending.copy(offline = true).label(before))
        assertEquals("Late · held for review", pending.copy(offline = true).label(close))
        assertTrue(closeTime(close).contains("10:00 PM · Asia/Manila"))
        assertEquals("Finish the open call first", SyncStatus.plainReason("call_open"))
        assertEquals("Visit customers in plan order", SyncStatus.plainReason("mcp_order"))
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

    /** FLD-147: the pill says photos are uploading, so the Sync screen must not say "Nothing waiting". */
    @Test fun photosWaitingAreNotNothingWaiting() {
        val status = SyncStatus(lastSuccess = 1, leaseExpiresAt = Long.MAX_VALUE, cacheExpiresAt = Long.MAX_VALUE,
            health = "synced", photosWaiting = 1)
        assertEquals("Visits synced · photos uploading", status.label(10))
        assertFalse(status.nothingWaiting)
        assertTrue(status.copy(photosWaiting = 0).nothingWaiting)
    }

    /** FLD-153: every refusal code the API can return (read from its source) and every phone code has plain words. */
    @Test fun everyRefusalCodeHasPlainWording() {
        var dir: java.io.File? = java.io.File("").absoluteFile
        while (dir != null && !java.io.File(dir, "apps/api/src/core/sync.js").exists()) dir = dir.parentFile
        val source = java.io.File(checkNotNull(dir) { "repo root not found" }, "apps/api/src/core/sync.js").readText()
        val block = Regex("""OP_CODES\s*=\s*Object\.freeze\(\[(.*?)\]\)""", RegexOption.DOT_MATCHES_ALL).find(source)!!.groupValues[1]
        val server = Regex("\"([a-z_]+)\"").findAll(block).map { it.groupValues[1] }.toList()
        assertTrue("OP_CODES parsed", server.size >= 16 && "invalid_plan" in server)
        val phone = listOf("dependency_missing", "rebootstrap_visit_changed", "photo_needs_review", "unknown_status",
            "review_required", "conflict", "rejected", "unsupported", "scope_changed", "device_revoked", "unauthorized") +
            com.sunpride.field.sync.VisitCodec.reasons
        val missing = (server + phone).filter { it !in SyncStatus.REASONS }
        assertTrue("codes without plain wording: $missing", missing.isEmpty())
        SyncStatus.REASONS.values.forEach { assertFalse(it, it.contains('_')) ; assertNotEquals("Visit needs administrator review", it) }
        // FLD-153 case: Start on a visit the office already marked missed is refused with invalid_plan.
        assertEquals("This visit was changed or closed by the office (for example marked missed)", SyncStatus.plainReason("invalid_plan"))
    }

    /** FLD-176: a refused item is viewable with its reason, clearable, and the pill reflects only real pending work. */
    @Test fun refusedItemsAreListedClearableAndNotUnsentWork() {
        val scope = com.sunpride.field.storage.StoreScope("account", "device", "scope")
        val start = com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(scope, "visit.checkIn", null, null, null,
            "p", "o", emptyList(), null, null, null, null, null, 1000)
        val refused = OutboxRow("account", "device", "scope", start.requestId, 1000, "review", "invalid_plan")
        val status = SyncStatus.fromRoom(partition, listOf(refused), intents = listOf(start))
        assertEquals(1, status.review)
        assertEquals(listOf(SyncStatus.ReviewItem(start.requestId, "Start visit", SyncStatus.plainReason("invalid_plan"))), status.reviewItems)
        assertTrue(status.nothingWaiting)
        assertEquals("Needs review", status.label(1100))
        assertEquals("Needs review · not synced", status.copy(queued = 1).label(1100))
        val cleared = SyncStatus.fromRoom(partition, listOf(refused), intents = listOf(start), dismissed = setOf(start.requestId))
        assertEquals(0, cleared.review)
        assertTrue(cleared.reviewItems.isEmpty())
        assertFalse(cleared.pending)
        assertEquals("All synced", cleared.label(1100))
    }

    /** FLD-122: a hold on this partition is retried by the background sync; earlier-sign-in work is not. */
    @Test fun backgroundSyncRetriesThisPartitionsHoldButNotEarlierWork() {
        val work = com.sunpride.field.sync.work.SyncWork
        val heldHere = SyncStatus.fromRoom(partition.copy(held = true, syncHealth = "held_for_review"), listOf(row("pending")))
        assertEquals("Held · needs review", heldHere.label(1100))
        assertTrue(work.shouldRun(heldHere))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("pending", "old-scope")))))
        assertTrue(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("pending")))))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("review", code = "invalid_plan")))))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, emptyList())))
    }
}
