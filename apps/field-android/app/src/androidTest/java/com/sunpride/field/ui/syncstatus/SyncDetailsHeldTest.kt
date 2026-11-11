package com.sunpride.field.ui.syncstatus

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import com.sunpride.field.storage.OutboxRow
import com.sunpride.field.storage.PartitionRow
import org.junit.Rule
import org.junit.Test

/** FLD-153: Sync shows what held work is and why, not just "Held 1". */
class SyncDetailsHeldTest {
    @get:Rule val rule = createComposeRule()

    @Test fun heldWorkShowsAPlainReasonCard() {
        val partition = PartitionRow("account", "device", "scope", activeGeneration = "g", leaseExpiresAt = 2000,
            cacheExpiresAt = 1500, syncHealth = "synced", lastSuccessfulSync = 1000)
        val status = SyncStatus.fromRoom(partition, listOf(OutboxRow("account", "device", "old", "r1", 1, "pending", null)))
        rule.setContent { SyncDetails(status, onDismiss = {}) }
        rule.onNodeWithTag("held-card").assertIsDisplayed()
        rule.onNodeWithText(SyncStatus.HELD_EARLIER).assertIsDisplayed()
    }
}
