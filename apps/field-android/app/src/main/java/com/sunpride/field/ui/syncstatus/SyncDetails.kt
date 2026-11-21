package com.sunpride.field.ui.syncstatus

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.sunpride.field.diagnostics.SupportInfo
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.ValueRow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val zone = ZoneId.of("Asia/Manila")
private val stamp = DateTimeFormatter.ofPattern("MMM d, yyyy h:mm a")
fun manilaTime(time: Long?): String = time?.let { stamp.format(Instant.ofEpochMilli(it).atZone(zone)) } ?: "Never"

/**
 * SP-0189: the salesman's Sync page shows whether everything is sent: "All sent" (with the last sent time),
 * "Waiting to send (N)" or "Waiting for signal". Saves the server did not accept are listed with a plain reason.
 */
@Composable
fun SyncDetails(status: SyncStatus, onDismiss: () -> Unit, onSync: () -> Unit = {},
    busy: Boolean = false, modifier: Modifier = Modifier, now: Long = System.currentTimeMillis(),
    message: String? = null) {
    Column(modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionCard("Status") {
                Text(status.label(now), Modifier.padding(horizontal = 16.dp, vertical = 12.dp).testTag("sync-state"),
                    style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                ValueRow("Last sent", manilaTime(status.lastSuccess), Modifier.testTag("sync-last-sent"))
            }
            if (status.notAccepted.isNotEmpty()) SectionCard("Needs your attention") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    status.notAccepted.take(20).forEach { item ->
                        Column(Modifier.fillMaxWidth().testTag("sync-not-accepted")) {
                            Text("${item.title} · ${manilaTime(item.at)}", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                            Text(item.text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
            (if (busy) SyncFeedback.RUNNING else message)?.let { feedback ->
                Text(feedback, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.testTag("sync-feedback").semantics { liveRegion = LiveRegionMode.Polite })
            }
            if (!status.nothingWaiting) Text(if (status.offline) "Your work is saved on this phone. It is sent " +
                "by itself when the phone has signal." else "Your work is saved on this phone and is being sent.",
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("sync-note"))
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        PrimaryBottomButton(if (busy) "Sending…" else "Sync now", onSync,
            Modifier.testTag("sync-now"), !busy)
    }
}

@Composable
fun SupportDetails(status: SyncStatus, onDismiss: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val text = SupportInfo(context).text(status)
    Column(modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
            com.sunpride.field.ui.SectionCard("For the Sunpride team") {
                Text(text, style = androidx.compose.material3.MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(16.dp).testTag("support-text"))
            }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        com.sunpride.field.ui.SecondaryButton("Copy support info", onClick = {
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("Sunpride support info", text))
        }, modifier = Modifier.fillMaxWidth().testTag("support-copy"))
    }
}
