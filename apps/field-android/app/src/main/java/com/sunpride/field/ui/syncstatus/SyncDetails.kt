package com.sunpride.field.ui.syncstatus

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.diagnostics.SupportInfo
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val zone = ZoneId.of("Asia/Manila")
private val stamp = DateTimeFormatter.ofPattern("MMM d, yyyy h:mm a 'Manila'")
fun manilaTime(time: Long?): String = time?.let { stamp.format(Instant.ofEpochMilli(it).atZone(zone)) } ?: "Never"

@Composable
fun SyncDetails(status: SyncStatus, onDismiss: () -> Unit) {
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Sync details") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(status.label(System.currentTimeMillis()), modifier = Modifier.testTag("detail-label"))
                Text("Queued: ${status.queued} · Sending: ${status.sending} · Needs review: ${status.review} · Held: ${status.held}")
                Text("Last successful sync: ${manilaTime(status.lastSuccess)}")
                Text("Cache: ${if (status.cacheStale(System.currentTimeMillis())) "Stale" else "Saved"}")
                Text("Lease: ${if (status.leaseExpired(System.currentTimeMillis())) "Expired — do not send" else "Valid until ${manilaTime(status.leaseExpiresAt)}"}")
                Text(if (status.offline) "Offline" else "Network available")
                if (status.held > 0) Text("Held work requires administrator review. Nothing is deleted or merged automatically.")
                status.reviewReasons.forEachIndexed { index, reason -> Text("Review ${index + 1}: $reason") }
            }
        }, confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } })
}

@Composable
fun SupportDetails(status: SyncStatus, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val text = SupportInfo(context).text(status)
    AlertDialog(onDismissRequest = onDismiss, title = { Text("Support info") },
        text = { Column(Modifier.verticalScroll(rememberScrollState())) {
            Text(text, modifier = Modifier.testTag("support-text"))
            OutlinedButton(onClick = {
                (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                    .setPrimaryClip(ClipData.newPlainText("Sunpride support info", text))
            }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp).testTag("support-copy")) { Text("Copy support info") }
        } }, confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } })
}
