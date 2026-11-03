package com.sunpride.chat.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sunpride.chat.Attachment
import com.sunpride.chat.ChatFormat
import com.sunpride.chat.ChatMessage
import com.sunpride.chat.ChatRow
import com.sunpride.chat.ChatTokens
import com.sunpride.chat.LinkPreview
import com.sunpride.chat.LocalAttachment
import com.sunpride.chat.PendingSend
import com.sunpride.chat.PendingState
import com.sunpride.chat.Segment

internal class MessageHandlers(
    val onLongPress: (ChatMessage) -> Unit,
    val onChip: (Segment.ObjectChip) -> Unit,
    val onImage: (Attachment) -> Unit,
    val onFile: (Attachment) -> Unit,
    val onReact: (ChatMessage, String) -> Unit,
    val onThread: (ChatMessage) -> Unit,
    val onRetry: (PendingSend) -> Unit,
    val onDiscard: (PendingSend) -> Unit,
)

@Composable
internal fun DayRow(label: String) {
    Box(Modifier.fillMaxWidth().padding(vertical = 10.dp), contentAlignment = Alignment.Center) {
        Text(label, Modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceVariant).padding(horizontal = 12.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun UnreadRow(count: Int) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
        Text(if (count == 1) "1 new message" else "$count new messages", Modifier.padding(horizontal = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
    }
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
internal fun MessageRowView(row: ChatRow.Msg, meIds: Set<String>, h: MessageHandlers, showThreadLink: Boolean = true) {
    val m = row.message
    val mine = row.mine
    val bubble = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
    val fg = if (mine) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = if (row.showHeader) 5.dp else 1.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        if (!mine) { if (row.showHeader) Avatar(m.author, 34.dp) else Spacer(Modifier.size(34.dp)); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.widthIn(max = 310.dp), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            if (row.showHeader) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 2.dp)) {
                if (!mine) {
                    Text(m.author.displayName, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    if (m.author.isAgent) { Spacer(Modifier.width(6.dp)); AiBadge() }
                    Spacer(Modifier.width(8.dp))
                }
                Text(ChatFormat.timeOfDay(m.createdAtMillis), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Surface(color = bubble, shape = RoundedCornerShape(16.dp),
                border = if (m.mentionsMe && !mine) androidx.compose.foundation.BorderStroke(1.5.dp, MaterialTheme.colorScheme.primary) else null,
                modifier = Modifier.clip(RoundedCornerShape(16.dp)).combinedClickable(onClick = {}, onLongClick = { h.onLongPress(m) })) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (m.deleted) {
                        Text("This message was deleted", style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = fg.copy(alpha = 0.7f))
                    } else {
                        if (m.body.isNotBlank()) MessageText(m.body, m.refs, meIds, fg, h.onChip)
                        m.attachments.forEach { AttachmentView(it, h) }
                        ChatTokens.objectChips(m.body, m.refs).forEach { RefCard(it, h.onChip) }
                        m.links.filter { it.ready }.take(3).forEach { LinkCard(it) }
                        if (m.edited) Text("(edited)", style = MaterialTheme.typography.labelSmall, color = fg.copy(alpha = 0.6f))
                    }
                }
            }
            if (m.reactions.isNotEmpty() && !m.deleted) FlowRow(Modifier.padding(top = 3.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                m.reactions.forEach { r ->
                    Text("${r.emoji} ${r.count}", Modifier.clip(RoundedCornerShape(12.dp))
                        .background(if (r.mine) MaterialTheme.colorScheme.primary.copy(alpha = 0.22f) else MaterialTheme.colorScheme.surfaceVariant)
                        .clickable { h.onReact(m, r.emoji) }.padding(horizontal = 8.dp, vertical = 3.dp),
                        style = MaterialTheme.typography.labelLarge, fontWeight = if (r.mine) FontWeight.Bold else FontWeight.Normal)
                }
            }
            if (showThreadLink && m.replyCount > 0 && !m.deleted) TextButton(onClick = { h.onThread(m) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp)) {
                Text(if (m.replyCount == 1) "1 reply" else "${m.replyCount} replies", style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

@Composable
internal fun SendingRowView(row: ChatRow.Sending, h: MessageHandlers) {
    val p = row.send
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 2.dp), horizontalArrangement = Arrangement.End) {
        Column(Modifier.widthIn(max = 310.dp), horizontalAlignment = Alignment.End) {
            Surface(color = MaterialTheme.colorScheme.primaryContainer.copy(alpha = if (p.state == PendingState.FAILED) 0.5f else 0.7f), shape = RoundedCornerShape(16.dp)) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (p.body.isNotBlank()) MessageText(p.body, emptyList(), emptySet(), MaterialTheme.colorScheme.onPrimaryContainer, {})
                    p.attachments.forEach { a -> Text((if (a.isImage) "🖼 " else "📎 ") + a.name, style = MaterialTheme.typography.bodySmall) }
                }
            }
            when (p.state) {
                PendingState.WAITING -> Text(if (p.attempts > 0) "Waiting for a connection · will send automatically" else "Sending…",
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 2.dp))
                PendingState.FAILED -> Column(horizontalAlignment = Alignment.End) {
                    Text("Not sent" + (p.failure?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.End)
                    Row { TextButton(onClick = { h.onRetry(p) }) { Text("Try again") }; TextButton(onClick = { h.onDiscard(p) }) { Text("Discard") } }
                }
            }
        }
    }
}

@Composable
private fun AttachmentView(a: Attachment, h: MessageHandlers) {
    if (a.isImage) {
        val ratio = if ((a.width ?: 0) > 0 && (a.height ?: 0) > 0) (a.width!!.toFloat() / a.height!!).coerceIn(0.6f, 1.8f) else 1.33f
        val image = rememberRemoteImage(a.thumbUrl ?: a.url, 640)
        Box(Modifier.width(220.dp).aspectRatio(ratio).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surface.copy(alpha = 0.5f)).clickable { h.onImage(a) },
            contentAlignment = Alignment.Center) {
            if (image != null) Image(image, contentDescription = "Photo ${a.name}. Tap to view", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().aspectRatio(ratio))
            else Text("🖼", style = MaterialTheme.typography.headlineMedium)
        }
    } else {
        CardRow(onClick = { h.onFile(a) }, modifier = Modifier.width(240.dp)) {
            Text(fileGlyph(a.mime), style = MaterialTheme.typography.headlineSmall)
            Column(Modifier.weight(1f)) {
                Text(a.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(fileKind(a.mime) + " · " + ChatFormat.fileSize(a.bytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

internal fun fileGlyph(mime: String) = when {
    mime == "application/pdf" -> "📕"; mime.contains("spreadsheet") || mime == "text/csv" -> "📊"; mime.contains("presentation") -> "📙"
    mime.contains("wordprocessing") -> "📘"; mime == "application/zip" -> "🗜️"; else -> "📄"
}
internal fun fileKind(mime: String) = when {
    mime == "application/pdf" -> "PDF"; mime == "text/csv" -> "CSV"; mime.contains("spreadsheet") -> "Excel"; mime.contains("presentation") -> "PowerPoint"
    mime.contains("wordprocessing") -> "Word"; mime == "application/zip" -> "Zip"; mime == "text/plain" -> "Text"; else -> "File"
}

@Composable
internal fun RefCard(chip: Segment.ObjectChip, onClick: (Segment.ObjectChip) -> Unit) {
    CardRow(onClick = { onClick(chip) }, modifier = Modifier.width(260.dp)) {
        RefThumb(chip.entry, chip.type, 40.dp)
        Column(Modifier.weight(1f)) {
            Text(chip.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val sub = if (chip.entry?.restricted == true) "You don't have access to this" else chip.entry?.subtitle
            Text(listOfNotNull(ChatTokens.typeLabel(chip.type), sub).joinToString(" · "), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
internal fun LinkCard(p: LinkPreview) {
    val uri = LocalUriHandler.current
    val image = rememberRemoteImage(p.imageUrl, 480)
    val safe = p.url.startsWith("https://") || p.url.startsWith("http://")
    Column(Modifier.width(260.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface)
        .clickable(enabled = safe) { runCatching { uri.openUri(p.url) } }.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        p.siteName?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text(p.title ?: p.url, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
        p.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().heightIn(max = 140.dp).clip(RoundedCornerShape(8.dp)))
    }
}

/** Local chip for a picked file waiting in the composer. */
@Composable
internal fun StagedAttachment(a: LocalAttachment, onRemove: () -> Unit) {
    CardRow(onClick = null, modifier = Modifier.width(220.dp)) {
        Text(if (a.isImage) "🖼" else fileGlyph(a.mime))
        Text(a.name, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        TextButton(onClick = onRemove, modifier = Modifier.alpha(1f)) { Text("✕") }
    }
}
