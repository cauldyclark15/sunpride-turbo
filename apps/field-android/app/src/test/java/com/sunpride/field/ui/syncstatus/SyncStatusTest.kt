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
