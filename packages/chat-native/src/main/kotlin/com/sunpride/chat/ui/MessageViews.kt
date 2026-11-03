package com.sunpride.chat.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
    Box(Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
        Text(label, Modifier.clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface)
            .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f), RoundedCornerShape(12.dp)).padding(horizontal = 12.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun UnreadRow(count: Int) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.primary)
        Text(if (count == 1) "1 new message" else "$count new messages", Modifier.padding(horizontal = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold)
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.primary)
    }
}

private val AVATAR = 32.dp
private val BUBBLE_MAX = 280.dp

/** Rounded bubble with a small corner on the sender's side for the first bubble of a run. */
private fun bubbleShape(mine: Boolean, first: Boolean): RoundedCornerShape {
    val tight = if (first) 4.dp else 18.dp
    return if (mine) RoundedCornerShape(topStart = 18.dp, topEnd = tight, bottomEnd = 18.dp, bottomStart = 18.dp)
    else RoundedCornerShape(topStart = tight, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 18.dp)
}

@OptIn(ExperimentalFoundationApi::class, ExperimentalLayoutApi::class)
@Composable
internal fun MessageRowView(row: ChatRow.Msg, meIds: Set<String>, h: MessageHandlers, showThreadLink: Boolean = true, showTime: Boolean = true) {
    val m = row.message
    val mine = row.mine
    val scheme = MaterialTheme.colorScheme
    val bubble = if (mine) scheme.primary else scheme.surfaceVariant
    val fg = if (mine) scheme.onPrimary else scheme.onSurface
    val shape = bubbleShape(mine, row.showHeader)
    Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = if (row.showHeader) 8.dp else 2.dp),
        horizontalArrangement = if (mine) Arrangement.End else Arrangement.Start) {
        if (!mine) { if (row.showHeader) Avatar(m.author, AVATAR, modifier = Modifier.padding(top = 18.dp)) else Spacer(Modifier.size(AVATAR)); Spacer(Modifier.width(8.dp)) }
        Column(Modifier.widthIn(max = BUBBLE_MAX), horizontalAlignment = if (mine) Alignment.End else Alignment.Start) {
            if (row.showHeader && !mine) Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = 4.dp, bottom = 2.dp)) {
                Text(m.author.displayName, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = scheme.onSurface,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (m.author.isAgent) { Spacer(Modifier.width(6.dp)); AiBadge() }
            }
            Surface(color = bubble, shape = shape, border = if (m.mentionsMe && !mine) androidx.compose.foundation.BorderStroke(1.5.dp, scheme.primary) else null,
                modifier = Modifier.clip(shape).combinedClickable(onClick = {}, onLongClick = { h.onLongPress(m) }, onLongClickLabel = "Message options")) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (m.deleted) {
                        Text("This message was deleted", style = MaterialTheme.typography.bodyMedium, fontStyle = FontStyle.Italic, color = fg.copy(alpha = 0.7f))
                    } else {
                        if (m.body.isNotBlank()) MessageText(m.body, m.refs, meIds, fg, h.onChip, onAccent = mine)
                        m.attachments.forEach { AttachmentView(it, h) }
                        ChatTokens.objectChips(m.body, m.refs).forEach { RefCard(it, h.onChip) }
                        m.links.filter { it.ready }.take(3).forEach { LinkCard(it) }
                    }
                }
            }
            if (m.reactions.isNotEmpty() && !m.deleted) FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                m.reactions.forEach { r ->
                    val rs = RoundedCornerShape(16.dp)
                    Row(Modifier.heightIn(min = 36.dp).clip(rs)
                        .background(if (r.mine) scheme.primary.copy(alpha = 0.12f) else scheme.surface)
                        .border(1.dp, if (r.mine) scheme.primary else scheme.onSurface.copy(alpha = 0.12f), rs)
                        .clickable(onClickLabel = if (r.mine) "Remove your reaction" else "React") { h.onReact(m, r.emoji) }.padding(horizontal = 10.dp),
                        verticalAlignment = Alignment.CenterVertically) {
                        Text("${r.emoji} ${r.count}", style = MaterialTheme.typography.labelLarge, fontWeight = if (r.mine) FontWeight.Bold else FontWeight.Normal,
                            color = if (r.mine) scheme.primary else scheme.onSurface)
                    }
                }
            }
            if (showThreadLink && m.replyCount > 0 && !m.deleted) TextButton(onClick = { h.onThread(m) }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 8.dp)) {
                Text(if (m.replyCount == 1) "1 reply" else "${m.replyCount} replies", style = MaterialTheme.typography.labelLarge)
            }
            if (showTime) Text(ChatFormat.timeOfDay(m.createdAtMillis) + if (m.edited && !m.deleted) " · Edited" else "",
                style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
        }
    }
}

@Composable
internal fun SendingRowView(row: ChatRow.Sending, h: MessageHandlers) {
    val p = row.send
    val scheme = MaterialTheme.colorScheme
    val shape = bubbleShape(true, row.showHeader)
    Row(Modifier.fillMaxWidth().padding(start = 8.dp, end = 12.dp, top = if (row.showHeader) 8.dp else 2.dp), horizontalArrangement = Arrangement.End) {
        Column(Modifier.widthIn(max = BUBBLE_MAX), horizontalAlignment = Alignment.End) {
            Surface(color = scheme.primary.copy(alpha = if (p.state == PendingState.FAILED) 0.45f else 0.7f), shape = shape) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (p.body.isNotBlank()) MessageText(p.body, emptyList(), emptySet(), scheme.onPrimary, {}, onAccent = true)
                    p.attachments.forEach { a ->
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Icon(if (a.isImage) ChatIcons.Photo else ChatIcons.File, contentDescription = null, tint = scheme.onPrimary, modifier = Modifier.size(16.dp))
                            Text(a.name, style = MaterialTheme.typography.bodySmall, color = scheme.onPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            when (p.state) {
                PendingState.WAITING -> Text(if (p.attempts > 0) "Waiting for a connection · will send automatically" else "Sending…",
                    style = MaterialTheme.typography.labelSmall, color = scheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                PendingState.FAILED -> Column(horizontalAlignment = Alignment.End) {
                    Text("Not sent" + (p.failure?.let { " · $it" } ?: ""), style = MaterialTheme.typography.labelSmall, color = scheme.error, textAlign = TextAlign.End,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
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
        Box(Modifier.width(232.dp).aspectRatio(ratio).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)).clickable(onClickLabel = "View photo") { h.onImage(a) },
            contentAlignment = Alignment.Center) {
            if (image != null) Image(image, contentDescription = "Photo ${a.name}. Tap to view", contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().aspectRatio(ratio))
            else Icon(ChatIcons.Photo, contentDescription = "Photo ${a.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(32.dp))
        }
    } else {
        CardRow(onClick = { h.onFile(a) }, modifier = Modifier.width(240.dp)) {
            FileBadge(a.mime)
            Column(Modifier.weight(1f)) {
                Text(a.name, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
                Text(fileKind(a.mime) + " · " + ChatFormat.fileSize(a.bytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** A tinted square with a document symbol and the file's short type. */
@Composable
private fun FileBadge(mime: String, size: androidx.compose.ui.unit.Dp = 40.dp) {
    Box(Modifier.size(size).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
        Icon(ChatIcons.Document, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(size * 0.55f))
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
    CardRow(onClick = { onClick(chip) }, modifier = Modifier.width(248.dp)) {
        RefThumb(chip.entry, chip.type, 40.dp)
        Column(Modifier.weight(1f)) {
            Text(chip.label, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
            val sub = if (chip.entry?.restricted == true) "You don't have access to this" else chip.entry?.subtitle
            Text(listOfNotNull(ChatTokens.typeLabel(chip.type), sub).joinToString(" · "), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
internal fun LinkCard(p: LinkPreview) {
    val uri = LocalUriHandler.current
    val image = rememberRemoteImage(com.sunpride.chat.ChatFormat.previewImage(p.imageUrl), 480)
    val safe = p.url.startsWith("https://") || p.url.startsWith("http://")
    Column(Modifier.width(248.dp).clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surface)
        .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.10f), RoundedCornerShape(12.dp))
        .clickable(enabled = safe) { runCatching { uri.openUri(p.url) } }.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        p.siteName?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Text(p.title ?: p.url, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurface)
        p.description?.let { Text(it, style = MaterialTheme.typography.bodySmall, maxLines = 3, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxWidth().heightIn(max = 140.dp).clip(RoundedCornerShape(8.dp)))
    }
}

/** Local chip for a picked file waiting in the composer. */
@Composable
internal fun StagedAttachment(a: LocalAttachment, onRemove: () -> Unit) {
    CardRow(onClick = null, modifier = Modifier.width(220.dp)) {
        if (a.isImage) Icon(ChatIcons.Photo, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp)) else FileBadge(a.mime, 32.dp)
        Text(a.name, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        ChatIconButton(ChatIcons.Close, "Remove ${a.name}", onRemove, tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
