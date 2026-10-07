package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.sunpride.van.sync.OfficeState
import com.sunpride.van.sync.SyncHealth
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME = DateTimeFormatter.ofPattern("MMM d, h:mm a")
private fun time(at: Long) = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(TIME)

/**
 * VAN-025 Sync & posting: the phone, the office (Convex) and SAP answered separately. Read-only — every number comes
 * from the encrypted outbox; nothing here talks to the network except the explicit Sync now button.
 */
@Composable fun SyncHealthScreen(c: VanController) {
    val s = c.sync
    val last = s.lastSyncTime?.let(::time) ?: "Not yet"
    ScreenFrame("Sync & posting",c::back,action = if (c.busy) "Syncing…" else "Sync now",actionTag = "sync-health-now",
        enabled = !c.busy,onAction = c::syncNow,message = c.message) {
        SectionCard("On this phone") {
            Text(SyncHealth.phoneLine(s),style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("health-phone"))
            Text("Everything you save is kept safely on this phone, even without signal. Do not reset or uninstall the app while work is kept here.",
                style = MaterialTheme.typography.bodyMedium)
            if (s.phoneOnly > 0) Text("${s.phoneOnly} saved here until the office can take them (sales, returns, cancelled sales, cash count)",
                Modifier.testTag("health-phone-only"))
        }
        SectionCard("Office") {
            Text(SyncHealth.officeLine(s,last),style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("health-office"))
            Text(SyncHealth.healthLabel(s.health),modifier = Modifier.testTag("health-state"))
            if (s.held > 0) Text("Sync is paused for this account. Your work stays on this phone. Ask your supervisor.",Modifier.testTag("health-paused"))
            if (s.review > 0) Text("The office could not accept ${s.review}. Tell your supervisor before the end of the trip.",Modifier.testTag("health-review"))
        }
        SectionCard("SAP") {
            Text(SyncHealth.sapLine(s),style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("health-sap"))
            Text("Van work is not posted to SAP from this phone yet. The office posts it to SAP later; \"Received by the office\" does not mean posted to SAP.",
                style = MaterialTheme.typography.bodyMedium)
        }
        if (s.items.isEmpty()) Text("No work saved on this phone yet.",Modifier.testTag("health-empty"))
        else {
            Text("Recent work",style = MaterialTheme.typography.titleMedium)
            s.items.forEachIndexed { i, item ->
                SectionCard(listOfNotNull(item.title,item.reference).joinToString(" · ")) {
                    Text(time(item.createdAt),style = MaterialTheme.typography.bodyMedium)
                    Text("Phone: saved",Modifier.testTag("health-item-phone-$i"))
                    Text("Office: ${item.office.label}",Modifier.testTag("health-item-office-$i"))
                    Text("SAP: ${item.sap.label}",Modifier.testTag("health-item-sap-$i"))
                    if (item.office == OfficeState.NEEDS_REVIEW) Text("Ask your supervisor about this one.")
                }
            }
            if (s.items.size >= SyncHealth.MAX_ITEMS) Text("Showing the latest ${SyncHealth.MAX_ITEMS}.",style = MaterialTheme.typography.bodyMedium)
        }
    }
}
