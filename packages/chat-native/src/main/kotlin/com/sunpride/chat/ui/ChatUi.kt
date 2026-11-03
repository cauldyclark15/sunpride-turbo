package com.sunpride.chat.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sunpride.chat.ChatEnvironment
import com.sunpride.chat.ChatFormat
import com.sunpride.chat.ChatRuntime
import com.sunpride.chat.ChatTokens
import com.sunpride.chat.RefEntry
import com.sunpride.chat.Segment
import com.sunpride.chat.UserLite
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import androidx.compose.ui.text.LinkAnnotation

internal val LocalChat = staticCompositionLocalOf<ChatRuntime> { error("Messages not ready") }
internal val LocalChatEnv = staticCompositionLocalOf<ChatEnvironment> { error("Messages not ready") }

/** A picture from the network or the saved copy; null while loading or when it can't be shown. */
@Composable
internal fun rememberRemoteImage(url: String?, maxDim: Int): ImageBitmap? {
    val images = LocalChat.current.images
    val state = produceState<ImageBitmap?>(url?.let { images.cached(it, maxDim)?.asImageBitmap() }, url, maxDim) {
        if (url != null && value == null) value = withContext(Dispatchers.IO) { runCatching { images.load(url, maxDim) }.getOrNull() }?.asImageBitmap()
    }
    return state.value
}

private val avatarColors = listOf(Color(0xFF8E3B46), Color(0xFF3B6E8E), Color(0xFF4F7942), Color(0xFF7A5C99), Color(0xFFB5651D), Color(0xFF2F7F79), Color(0xFF8A6D3B), Color(0xFF5B6C8F))

@Composable
internal fun Avatar(user: UserLite?, size: Dp = 36.dp, label: String? = null, modifier: Modifier = Modifier) {
    val name = label ?: user?.displayName ?: "?"
    val image = rememberRemoteImage(user?.avatarUrl, 128)
    Box(modifier.size(size).clip(CircleShape).background(avatarColors[Math.floorMod(name.hashCode(), avatarColors.size)]), contentAlignment = Alignment.Center) {
        if (image != null) Image(image, contentDescription = name, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
        else Text(ChatFormat.initials(name), color = Color.White, fontSize = (size.value * 0.38f).sp, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
internal fun AiBadge(modifier: Modifier = Modifier) {
    Text("AI", modifier = modifier.clip(RoundedCornerShape(4.dp)).background(MaterialTheme.colorScheme.tertiaryContainer).padding(horizontal = 5.dp, vertical = 1.dp),
        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onTertiaryContainer, fontWeight = FontWeight.Bold)
}

@Composable
internal fun CountBadge(count: Int, mention: Boolean = false, modifier: Modifier = Modifier) {
    if (count <= 0 && !mention) return
    val bg = if (mention) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    val fg = if (mention) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onPrimary
    Box(modifier.heightIn(min = 20.dp).widthIn(min = 20.dp).clip(CircleShape).background(bg).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
        Text(if (mention && count <= 1) "@" else if (count > 99) "99+" else count.toString(), color = fg, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold)
    }
}

/** Every screen has a visible way back; the phone's Back key does the same (see ChatHost). */
@Composable
internal fun ChatTopBar(title: String, onBack: (() -> Unit)?, subtitle: String? = null, actions: @Composable RowScope.() -> Unit = {}) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp) {
        Column {
            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                if (onBack != null) TextButton(onClick = onBack, modifier = Modifier.semantics { contentDescription = "Back" }) { Text("‹ Back") }
                else Spacer(Modifier.width(12.dp))
                Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
                    Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                actions()
            }
            HorizontalDivider()
        }
    }
}

@Composable
internal fun Banner(text: String, error: Boolean = false, modifier: Modifier = Modifier) {
    Text(text, modifier.fillMaxWidth().background(if (error) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer)
        .padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall,
        color = if (error) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer)
}

internal fun typeGlyph(type: String): String = when (type) {
    "user" -> "👤"; "outlet" -> "🏬"; "product" -> "📦"; "customer" -> "🧑‍💼"; "issue" -> "⚠️"; "order" -> "🧾"
    "visit" -> "📍"; "territory" -> "🗺️"; "route" -> "🛣️"; "van_trip" -> "🚚"; else -> "🔖"
}

/** The small thumbnail (or a type symbol when there is none) used by chips, cards and pickers. */
@Composable
internal fun RefThumb(entry: RefEntry?, type: String, size: Dp = 40.dp) {
    val image = rememberRemoteImage(entry?.thumbUrl?.takeIf { entry.access == "ok" }, 160)
    Box(Modifier.size(size).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
        if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(size))
        else Text(typeGlyph(type), fontSize = (size.value * 0.5f).sp)
    }
}

/** Rich message text: names and objects as chips, web links tappable, never a raw token. */
@Composable
internal fun MessageText(body: String, refs: List<RefEntry>, meIds: Set<String>, color: Color, onChip: (Segment.ObjectChip) -> Unit, modifier: Modifier = Modifier) {
    val primary = MaterialTheme.colorScheme.primary
    val chipBg = MaterialTheme.colorScheme.primary.copy(alpha = 0.14f)
    val objBg = MaterialTheme.colorScheme.secondary.copy(alpha = 0.16f)
    val text = androidx.compose.runtime.remember(body, refs, meIds, color) {
        buildAnnotatedString {
            for (seg in ChatTokens.parse(body, refs)) when (seg) {
                is Segment.Text -> appendWithLinks(seg.text, primary)
                is Segment.UserMention -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = primary, background = chipBg)) { append(" @${seg.label} ") }
                Segment.Channel -> withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = primary, background = chipBg)) { append(" @channel ") }
                is Segment.ObjectChip -> withLink(LinkAnnotation.Clickable("ref:${seg.type}:${seg.id}",
                    TextLinkStyles(SpanStyle(fontWeight = FontWeight.Medium, color = color, background = objBg))) { onChip(seg) }) { append(" ${typeGlyph(seg.type)} ${seg.label} ") }
            }
        }
    }
    Text(text, modifier, color = color, style = MaterialTheme.typography.bodyLarge)
}

private val URL_RE = Regex("https?://[^\\s<>\"']+")
private fun AnnotatedString.Builder.appendWithLinks(text: String, linkColor: Color) {
    var last = 0
    for (m in URL_RE.findAll(text)) {
        val url = m.value.trimEnd('.', ',', ')', ';', '!', '?')
        if (m.range.first > last) append(text.substring(last, m.range.first))
        withLink(LinkAnnotation.Url(url, TextLinkStyles(SpanStyle(color = linkColor, textDecoration = TextDecoration.Underline)))) { append(url) }
        last = m.range.first + url.length
    }
    if (last < text.length) append(text.substring(last))
}

/** A tap target row used by pickers, cards and lists. */
@Composable
internal fun CardRow(onClick: (() -> Unit)?, modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    val base = modifier.fillMaxWidth().clip(shape).border(BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant), shape)
    Row((if (onClick != null) base.clickable(onClick = onClick) else base).padding(10.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp), content = content)
}
