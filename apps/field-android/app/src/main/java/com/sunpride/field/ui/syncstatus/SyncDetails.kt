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
    busy: Boolean = false, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionCard("Status") {
                ValueRow(if (status.queued == 0 && status.sending == 0) "Nothing waiting" else "Waiting",
                    if (status.queued == 0 && status.sending == 0) "" else "${status.queued + status.sending}",
                    Modifier.testTag("detail-waiting"))
                if (status.review > 0) ValueRow("To review", "${status.review}")
                if (status.held > 0) ValueRow("Held", "${status.held}")
                if (status.sending > 0) ValueRow("Sending", "${status.sending}")
                ValueRow("Last sync", manilaTime(status.lastSuccess))
                ValueRow("Access until", manilaTime(status.leaseExpiresAt))
            }
            if (status.reviewReasons.isNotEmpty()) SectionCard("To review · ${status.review}") {
                status.reviewReasons.forEach { Text(it, Modifier.padding(16.dp)) }
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
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Text(text, modifier = Modifier.weight(1f).verticalScroll(rememberScrollState())
            .padding(bottom = 16.dp).testTag("support-text"))
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        com.sunpride.field.ui.SecondaryButton("Copy support info", onClick = {
            (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("Sunpride support info", text))
        }, modifier = Modifier.fillMaxWidth().testTag("support-copy"))
    }
}
