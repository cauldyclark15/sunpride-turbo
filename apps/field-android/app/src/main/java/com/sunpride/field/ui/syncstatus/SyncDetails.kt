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

@Composable
fun SyncDetails(status: SyncStatus, onDismiss: () -> Unit, onSync: () -> Unit = {},
    busy: Boolean = false, modifier: Modifier = Modifier, onClearReview: (String) -> Unit = {}) {
    Column(modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionCard("Status") {
                val visits = status.queued + status.sending
                ValueRow(if (status.nothingWaiting) "Nothing waiting" else if (visits == 0) "Visits" else "Waiting",
                    if (status.nothingWaiting) "" else if (visits == 0) "Synced" else "$visits",
                    Modifier.testTag("detail-waiting"))
                if (status.photosWaiting > 0) ValueRow("Photos waiting", "${status.photosWaiting}",
                    Modifier.testTag("detail-photos"))
                if (status.review > 0) ValueRow("To review", "${status.review}")
                if (status.held > 0) ValueRow("Held", "${status.held}")
                if (status.sending > 0) ValueRow("Sending", "${status.sending}")
                ValueRow("Last sync", manilaTime(status.lastSuccess))
                Column(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("Day close", style = MaterialTheme.typography.bodyMedium)
                    Text(closeTime(status.leaseExpiresAt), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("day-close-time"))
                }
            }
            // FLD-176: each refused item shows what it was and why, and can be cleared once read. The office was
            // never sent anything for it, so clearing only tidies this phone; the visit can be started again.
            if (status.reviewItems.isNotEmpty()) SectionCard("To review · ${status.review}", Modifier.testTag("review-card")) {
                status.reviewItems.forEach { item ->
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("${item.what} · not accepted", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                        Text(item.reason, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("review-reason"))
                        TextButton({ onClearReview(item.requestId) }, enabled = !busy,
                            modifier = Modifier.testTag("review-clear")) { Text("Clear from this phone") }
                    }
                }
            } else if (status.reviewReasons.isNotEmpty()) SectionCard("To review · ${status.review}") {
                status.reviewReasons.forEach { Text(it, Modifier.padding(16.dp)) }
            }
            if (status.held > 0 || status.heldReasons.isNotEmpty()) SectionCard("Held · ${status.held}", Modifier.testTag("held-card")) {
                status.heldReasons.ifEmpty { listOf(SyncStatus.HELD_EARLIER) }.forEach { Text(it, Modifier.padding(16.dp)) }
            }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        PrimaryBottomButton(if (busy) "Syncing…" else "Sync now", onSync,
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
