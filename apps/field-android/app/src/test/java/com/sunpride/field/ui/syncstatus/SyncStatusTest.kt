package com.sunpride.field.ui.syncstatus

import com.sunpride.field.storage.OutboxRow
import com.sunpride.field.storage.PartitionRow
import org.junit.Assert.*
import org.junit.Test

class SyncStatusTest {
    private val partition = PartitionRow("account", "device", "scope", activeGeneration = "generation",
        leaseExpiresAt = 2000, cacheExpiresAt = 1500, syncHealth = "synced", lastSuccessfulSync = 1000)
    private fun row(state: String, scope: String = "scope", code: String? = null, id: String = "$state-$scope") =
        OutboxRow("account", "device", scope, id, 1, state, code)

    /** SP-0189: the pill and Sync page only ever say one of three things. */
    @Test fun onlyThreeStatesEverShow() {
        val seen = mutableSetOf<String>()
        val partitions = listOf(null, partition, partition.copy(held = true, syncHealth = "held_for_review"),
            partition.copy(lastSuccessfulSync = null, leaseExpiresAt = null), partition.copy(syncHealth = "retry_pending"))
        val rowSets = listOf(emptyList(), listOf(row("pending")), listOf(row("sending")), listOf(row("review", code = "invalid_request")),
            listOf(row("office", code = "invalid_request")), listOf(row("pending", "old-scope")), listOf(row("done")),
            listOf(row("pending"), row("review", id = "r"), row("office", id = "o"), row("pending", "old-scope")))
        for (p in partitions) for (rows in rowSets) for (offline in listOf(false, true)) for (now in listOf(1100L, 2500L, Long.MAX_VALUE - 1))
            for (photos in listOf(0, 2)) {
                val label = SyncStatus.fromRoom(p, rows, offline).copy(photosWaiting = photos).label(now)
                seen += label
                assertTrue(label, label == SyncStatus.ALL_SENT || label == SyncStatus.WAITING_FOR_SIGNAL ||
                    Regex("""(Waiting to send|Not accepted) \(\d+\)""").matches(label))
                SyncStatus.FORBIDDEN_WORDS.forEach { assertFalse(label, label.lowercase().contains(it)) }
            }
        assertTrue(seen.toString(), SyncStatus.ALL_SENT in seen && SyncStatus.WAITING_FOR_SIGNAL in seen &&
            seen.any { it.startsWith("Waiting to send (") })
    }

    @Test fun waitingCountsQueuedSendingHeldAndPhotos() {
        val rows = listOf(row("pending"), row("sending"), row("pending", "old-scope"))
        val status = SyncStatus.fromRoom(partition, rows).copy(photosWaiting = 2)
        assertEquals("Waiting to send (5)", status.label(1100))
        assertEquals("Waiting for signal", status.copy(offline = true).label(1100))
        assertEquals("All sent", SyncStatus.fromRoom(partition, emptyList()).label(1100))
        assertEquals("All sent", SyncStatus.fromRoom(partition, emptyList(), offline = true).label(1100))
        // Items held under an earlier sign-in count as waiting to send.
        assertEquals("Waiting to send (1)", SyncStatus.fromRoom(partition, listOf(row("pending", "old-scope"))).label(1100))
        assertEquals("Waiting to send (1)", SyncStatus.fromRoom(partition.copy(held = true), listOf(row("pending"))).label(1100))
    }

    /** SP-0189: a save the office kept is not shown or counted; an older-server refusal is internal only. */
    @Test fun refusedAndKeptSavesAreNeverListedOrWaiting() {
        val kept = SyncStatus.fromRoom(partition, listOf(row("office", code = "invalid_request")))
        assertEquals(0, kept.review); assertTrue(kept.nothingWaiting); assertFalse(kept.pending)
        assertEquals("All sent", kept.label(1100))
        val refused = SyncStatus.fromRoom(partition, listOf(row("review", code = "invalid_request")))
        assertEquals(1, refused.review); assertTrue(refused.nothingWaiting); assertFalse(refused.pending)
        assertEquals("All sent", refused.label(1100))
        val mixed = SyncStatus.fromRoom(partition, listOf(row("review", id = "a"), row("pending", id = "b")))
        assertEquals("Waiting to send (1)", mixed.label(1100))
    }

    @Test fun countsAndExpiryAreRoomDerived() {
        val rows = listOf(row("pending"), row("sending"), row("review", code = "conflict"), row("pending", "old-scope"))
        val status = SyncStatus.fromRoom(partition, rows)
        assertEquals(1, status.queued); assertEquals(1, status.sending); assertEquals(1, status.review); assertEquals(1, status.held)
        assertFalse(status.leaseExpired(1999)); assertTrue(status.leaseExpired(2000))
        assertTrue(status.cacheStale(1500)); assertFalse(status.cacheStale(1499))
    }

    @Test fun heldWorkKeepsInternalReasons() {
        assertEquals(listOf(SyncStatus.HELD_EARLIER), SyncStatus.fromRoom(partition, listOf(row("pending", "old-scope"))).heldReasons)
        assertEquals(listOf(SyncStatus.HELD_ACCESS), SyncStatus.fromRoom(partition.copy(held = true), listOf(row("pending"))).heldReasons)
        assertTrue(SyncStatus.fromRoom(partition, listOf(row("pending"))).heldReasons.isEmpty())
    }

    @Test fun closeBoundaryUsesManilaNotUtc() {
        val close = java.time.Instant.parse("2026-10-02T14:00:00Z").toEpochMilli()
        assertEquals(close, dayClose("2026-10-02"))
        assertTrue(closeTime(close).contains("10:00 PM · Asia/Manila"))
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
        assertEquals("Waiting to send (1)", status.label(endAt))
    }

    @Test fun newCustomerHasAName() {
        assertEquals("New customer", SyncStatus.describe("census.capture"))
        assertEquals("Order", SyncStatus.describe("order_intent"))
    }

    /** FLD-153: every refusal code the API can return still has internal plain wording (office list reuses it). */
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
        assertEquals("Finish the open call first", SyncStatus.plainReason("call_open"))
    }

    /** FLD-122: a hold on this partition is retried by the background sync; earlier-sign-in work is not. */
    @Test fun backgroundSyncRetriesThisPartitionsHoldButNotEarlierWork() {
        val work = com.sunpride.field.sync.work.SyncWork
        val heldHere = SyncStatus.fromRoom(partition.copy(held = true, syncHealth = "held_for_review"), listOf(row("pending")))
        assertTrue(work.shouldRun(heldHere))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("pending", "old-scope")))))
        assertTrue(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("pending")))))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("review", code = "invalid_plan")))))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, listOf(row("office", code = "invalid_plan")))))
        assertFalse(work.shouldRun(SyncStatus.fromRoom(partition, emptyList())))
    }

    private fun intent(id: String, kind: String) = com.sunpride.field.storage.IntentRow("account", "device", "scope", id, "visit-1", kind, "{}", 1)

    /** QA 2026-11-21: a refused Start is never "Saved" or "All sent"; it says Not accepted with a plain reason. */
    @Test fun refusedSavesSayNotAcceptedEverywhere() {
        assertEquals("Not accepted: this visit was changed or closed by the office (for example marked missed)",
            SyncStatus.itemState("office", "invalid_plan"))
        assertTrue(SyncStatus.itemState("review", null).startsWith("Not accepted: "))
        assertEquals("Waiting to send", SyncStatus.itemState("pending")); assertEquals("Sent", SyncStatus.itemState("done"))
        val now = 10L * 86_400_000L
        val history = listOf(intent("a", "visit.checkIn") to row("office", code = "invalid_plan", id = "a").copy(createdAt = now - 1000),
            intent("b", "visit.checkOut") to row("done", id = "b").copy(createdAt = now),
            intent("c", "visit.activity") to row("review", id = "c").copy(createdAt = now - 5 * 86_400_000L),
            intent("d", "visit.activity") to row("review", id = "d").copy(createdAt = now - 10))
        val items = SyncStatus.notAcceptedFrom(history, dismissed = setOf("d"), now = now)
        assertEquals(listOf("a"), items.map { it.requestId })
        assertEquals("Start visit", items.single().title)
        val status = SyncStatus.fromRoom(partition, emptyList()).copy(notAccepted = items)
        assertEquals("Not accepted (1)", status.label(1100))
        assertEquals("Waiting to send (1)", status.copy(queued = 1).label(1100))
        SyncStatus.FORBIDDEN_WORDS.forEach { w -> SyncStatus.REASONS.keys.forEach { c ->
            assertFalse("$c: $w", SyncStatus.notAcceptedText(c).lowercase().contains(w)) } }
    }

    /** QA retest: a refusal clears once the retry of the same step is accepted; other refusals stay. */
    @Test fun acceptedRetryClearsNotAccepted() {
        val now = 10L * 86_400_000L
        val retried = listOf(intent("a", "visit.checkIn") to row("office", code = "invalid_plan", id = "a").copy(createdAt = now - 1000),
            intent("a2", "visit.checkIn") to row("done", id = "a2").copy(createdAt = now - 500))
        assertEquals(emptyList<String>(), SyncStatus.notAcceptedFrom(retried, emptySet(), now).map { it.requestId })
        val otherStep = listOf(intent("a", "visit.checkIn") to row("office", code = "invalid_plan", id = "a").copy(createdAt = now - 1000),
            intent("b", "visit.checkOut") to row("done", id = "b").copy(createdAt = now))
        assertEquals(listOf("a"), SyncStatus.notAcceptedFrom(otherStep, emptySet(), now).map { it.requestId })
    }

    /** QA retest: offline, the Sync page never keeps saying "your phone is up to date". */
    @Test fun staleUpToDateHiddenWhileOffline() {
        val status = SyncStatus()
        assertEquals(SyncFeedback.UPDATED, SyncFeedback.shown(SyncFeedback.UPDATED, status))
        assertNull(SyncFeedback.shown(SyncFeedback.UPDATED, status.copy(offline = true)))
        assertNull(SyncFeedback.shown(SyncFeedback.UPDATED, status.copy(queued = 1)))
        assertEquals(SyncFeedback.UNAVAILABLE, SyncFeedback.shown(SyncFeedback.UNAVAILABLE, status.copy(offline = true)))
    }
}
