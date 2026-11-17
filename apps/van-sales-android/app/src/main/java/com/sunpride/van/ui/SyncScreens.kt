package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sunpride.van.sync.SyncHealth
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME = DateTimeFormatter.ofPattern("MMM d, h:mm a")
private fun time(at: Long) = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(TIME)

/**
 * SP-0190: the seller sees only "All sent", "Waiting to send (N)" or "Waiting for signal (N)", with when work was last
 * sent. Nothing the office must look at is listed here; the office has its own copy. Read-only apart from Sync now.
 */
@Composable fun SyncHealthScreen(c: VanController) {
    val s = c.sync
    val last = s.lastSyncTime?.let(::time) ?: "Not yet"
    ScreenFrame("Sync & posting",c::back,action = if (c.busy) "Sending…" else "Sync now",actionTag = "sync-health-now",
        enabled = !c.busy,onAction = c::syncNow,message = c.message) {
        SectionCard(SyncHealth.line(s)) {
            Text("Last sent: $last",style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("health-last"))
            SyncHealth.healthLabel(s.health)?.let { Text(it,Modifier.testTag("health-state")) }
            Text("Everything you save is kept on this phone, even without signal, and sent by itself.",
                style = MaterialTheme.typography.bodyMedium)
        }
        // SP-0169: a receipt number the office cancelled still needs the seller at the customer (money and goods).
        s.items.filter { it.rejectionCode == com.sunpride.van.selling.RefusedReceipt.CODE }.forEachIndexed { i, item ->
            SectionCard(listOfNotNull(item.title,item.reference).joinToString(" · ")) {
                Text(com.sunpride.van.selling.RefusedReceipt.message(item.reference,item.kind),Modifier.testTag("health-item-spoiled-$i"))
            }
        }
    }
}
