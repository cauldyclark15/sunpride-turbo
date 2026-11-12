package com.sunpride.chat.ui

import androidx.compose.foundation.Image
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.focus.focusRequester
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.chat.Attachment
import com.sunpride.chat.ChatErrors
import com.sunpride.chat.ChatException
import com.sunpride.chat.ChatFormat
import com.sunpride.chat.ChatTokens
import com.sunpride.chat.Conversation
import com.sunpride.chat.ConversationDetail
import com.sunpride.chat.SearchHit
import com.sunpride.chat.UserLite
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
internal fun NewChatScreen(onBack: () -> Unit, onCreated: (String) -> Unit) {
    val repo = LocalChat.current.repository
    val me by repo.myIds.collectAsState()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf(0) }
    var q by remember { mutableStateOf("") }
    var people by remember { mutableStateOf(emptyList<UserLite>()) }
    var picked by remember { mutableStateOf(emptyList<UserLite>()) }
    var title by remember { mutableStateOf("") }
    var topic by remember { mutableStateOf("") }
    var isPrivate by remember { mutableStateOf(false) }
    var channels by remember { mutableStateOf(emptyList<Conversation>()) }
    var busy by remember { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(q, mode) {
        delay(200)
        try {
            if (mode == 2) channels = repo.browseChannels(q) else people = repo.searchPeople(q).filter { it.id !in me }
            problem = null
        } catch (e: ChatException) { problem = ChatErrors.words(e) }
    }
    fun run(block: suspend () -> Conversation) {
        scope.launch {
            busy = true
            try { onCreated(block().id) } catch (e: ChatException) { problem = ChatErrors.words(e).takeUnless { e is ChatException.Api && e.code == "invalid" } ?: "Check the details and try again." }
            busy = false
        }
    }
    Column(Modifier.fillMaxSize()) {
        ChatTopBar("New conversation", onBack)
        Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Direct message", "Group", "Channel").forEachIndexed { i, label ->
                FilterChip(selected = mode == i, onClick = { mode = i; q = ""; problem = null }, label = { Text(label) },
                    colors = FilterChipDefaults.filterChipColors(selectedContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), selectedLabelColor = MaterialTheme.colorScheme.primary))
            }
        }
        problem?.let { Banner(it, error = true) }
        if (mode == 1 || mode == 0) {
            PillSearchField(q, { q = it }, "Search people", Modifier.padding(horizontal = 12.dp))
            if (mode == 1) {
                if (picked.isNotEmpty()) Text("Added: " + picked.joinToString(", ") { it.displayName } + "  (tap a name below to remove)", Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(title, { title = it.take(80) }, Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), singleLine = true, label = { Text("Group name (optional)") })
            }
            LazyColumn(Modifier.weight(1f)) {
                items(people, key = { it.id }) { u ->
                    val on = picked.any { it.id == u.id }
                    Row(Modifier.fillMaxWidth().clickable(enabled = !busy) {
                        if (mode == 0) run { repo.startDm(u.id) } else picked = if (on) picked.filter { it.id != u.id } else picked + u
                    }.padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Avatar(u, 40.dp)
                        Column(Modifier.weight(1f)) {
                            Row(verticalAlignment = Alignment.CenterVertically) { Text(u.displayName, style = MaterialTheme.typography.bodyLarge); if (u.isAgent) { Spacer(Modifier.width(6.dp)); AiBadge() } }
                            (u.roleLabel?.replaceFirstChar { it.uppercase() } ?: if (u.isAgent) "Developer" else null)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                        if (mode == 1) Text(if (on) "✓" else "", style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.primary)
                    }
                }
                if (people.isEmpty()) item { Text("No people found", Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            if (mode == 1) Button(onClick = { run { repo.startGroup(picked.map { it.id }, title.ifBlank { null }) } }, enabled = picked.size >= 2 && !busy,
                modifier = Modifier.fillMaxWidth().padding(12.dp).navigationBarsPadding()) { Text(if (picked.size < 2) "Add at least 2 people" else "Create group") }
        } else {
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(title, { title = it.take(80) }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Channel name") })
                OutlinedTextField(topic, { topic = it.take(250) }, Modifier.fillMaxWidth(), label = { Text("What is it about? (optional)") })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) { Text("Private channel"); Text("Only people you add can see it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Switch(isPrivate, { isPrivate = it })
                }
                Button(onClick = { run { repo.startChannel(title, topic.ifBlank { null }, isPrivate) } }, enabled = title.isNotBlank() && !busy, modifier = Modifier.fillMaxWidth()) { Text("Create channel") }
                HorizontalDivider(Modifier.padding(vertical = 8.dp))
                Text("Join an existing channel", style = MaterialTheme.typography.titleSmall)
                OutlinedTextField(q, { q = it }, Modifier.fillMaxWidth(), singleLine = true, label = { Text("Search channels") })
                if (channels.isEmpty()) Text("No channels to join", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                channels.forEach { c ->
                    CardRow(onClick = null) {
                        Avatar(null, 36.dp, label = "#")
                        Column(Modifier.weight(1f)) {
                            Text("# " + (c.title ?: "Channel"), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(c.topic?.takeIf { it.isNotBlank() } ?: "${c.memberCount} members", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                        OutlinedButton(onClick = { run { repo.join(c) } }, enabled = !busy) { Text("Join") }
                    }
                }
            }
        }
    }
}

/** A rounded search box with a magnifier, like the one on the conversation list. */
@Composable
internal fun PillSearchField(value: String, onChange: (String) -> Unit, hint: String, modifier: Modifier = Modifier, autoFocus: Boolean = false) {
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    LaunchedEffect(Unit) { if (autoFocus) { delay(100); runCatching { focus.requestFocus() } } }
    TextField(value, onChange, modifier.fillMaxWidth().focusRequester(focus), singleLine = true, placeholder = { Text(hint, maxLines = 1) },
        leadingIcon = { Icon(ChatIcons.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingIcon = if (value.isNotEmpty()) ({ ChatIconButton(ChatIcons.Close, "Clear search", { onChange("") }, tint = MaterialTheme.colorScheme.onSurfaceVariant) }) else null,
        shape = RoundedCornerShape(28.dp),
        colors = TextFieldDefaults.colors(
            focusedContainerColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f), unfocusedContainerColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f),
            focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent))
}

@Composable
internal fun SearchScreen(onBack: () -> Unit, onOpen: (String) -> Unit) {
    val repo = LocalChat.current.repository
    val me by repo.myIds.collectAsState()
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var hits by remember { mutableStateOf(emptyList<SearchHit>()) }
    var next by remember { mutableStateOf<String?>(null) }
    var state by remember { mutableStateOf("idle") }   // idle, searching, done, error
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(q) {
        if (q.trim().length < 2) { hits = emptyList(); next = null; state = "idle"; return@LaunchedEffect }
        delay(350); state = "searching"
        try { val p = repo.searchMessages(q.trim()); hits = p.items; next = p.nextCursor; state = "done"; problem = null }
        catch (e: ChatException) { problem = ChatErrors.words(e); state = "error" }
    }
    Column(Modifier.fillMaxSize()) {
        ChatTopBar("Search messages", onBack)
        PillSearchField(q, { q = it }, "Search what people wrote", Modifier.padding(12.dp), autoFocus = true)
        problem?.let { Banner(it, error = true) }
        LazyColumn(Modifier.fillMaxSize()) {
            items(hits, key = { it.message.id }) { h ->
                Column(Modifier.fillMaxWidth().clickable { onOpen(h.conversationId) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                    Text(listOfNotNull(h.conversationTitle?.let { if (h.conversationKind == "channel") "# $it" else it }, h.message.author.displayName).joinToString(" · "),
                        style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text(ChatTokens.plain(h.message.body, h.message.refs).replace('\n', ' '), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    Text(ChatFormat.dayLabel(h.message.createdAtMillis, System.currentTimeMillis()) + " " + ChatFormat.timeOfDay(h.message.createdAtMillis), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                HorizontalDivider()
            }
            item {
                when {
                    state == "searching" -> Text("Searching…", Modifier.padding(16.dp))
                    state == "idle" -> Text("Type at least 2 letters. Only conversations you are in are searched.", Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state == "done" && hits.isEmpty() -> Text("Nothing found for \"$q\".", Modifier.padding(16.dp))
                    next != null -> TextButton(onClick = { scope.launch { try { val p = repo.searchMessages(q.trim(), next); hits = hits + p.items; next = p.nextCursor } catch (e: ChatException) { problem = ChatErrors.words(e) } } },
                        modifier = Modifier.padding(8.dp)) { Text("Show more") }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DetailsSheet(conversationId: String, onDismiss: () -> Unit, onLeft: () -> Unit) {
    val repo = LocalChat.current.repository
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val me by repo.myIds.collectAsState()
    val convs by repo.conversations.collectAsState()
    val conv = convs.items.firstOrNull { it.id == conversationId }
    var detail by remember { mutableStateOf<ConversationDetail?>(null) }
    var confirm by remember { mutableStateOf(false) }
    LaunchedEffect(conversationId) { detail = runCatching { repo.detail(conversationId) }.getOrNull() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ConversationAvatar(conv, me, 48.dp, conv?.let { ChatFormat.title(it, me) } ?: "Conversation")
                Text(conv?.let { ChatFormat.title(it, me) } ?: "Conversation", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                ChatIconButton(ChatIcons.Close, "Close", onDismiss, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            conv?.topic?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
            if (conv != null) Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) { Text("Mute notifications"); Text("You'll still see it in your list", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                Switch(conv.muted, { on -> scope.launch { try { repo.setMuted(conversationId, on) } catch (e: ChatException) { toast(ctx, ChatErrors.words(e)) } } })
            }
            HorizontalDivider()
            Text(((detail?.members?.size ?: conv?.memberCount) ?: 0).let { if (it == 1) "1 person" else "$it people" }, style = MaterialTheme.typography.titleSmall)
            Column(Modifier.verticalScroll(rememberScrollState()).weight(1f, fill = false)) {
                (detail?.members ?: emptyList()).forEach { m ->
                    Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Avatar(m.user, 36.dp)
                        Text(m.user.displayName + if (m.user.id in me) " (you)" else "", Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodyLarge)
                        if (m.user.isAgent) AiBadge()
                        if (m.role == "owner") Text("Owner", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (detail == null) Text("Loading people…", style = MaterialTheme.typography.bodySmall)
            }
            if (conv != null && !conv.isDm) OutlinedButton(onClick = { confirm = true }, modifier = Modifier.fillMaxWidth()) { Text(if (conv.isChannel) "Leave channel" else "Leave group", color = MaterialTheme.colorScheme.error) }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("Leave this conversation?") }, text = { Text("You will stop getting its messages.") },
        confirmButton = { TextButton(onClick = { confirm = false; scope.launch { try { repo.leave(conversationId); onLeft() } catch (e: ChatException) { toast(ctx, ChatErrors.words(e)) } } }) { Text("Leave") } },
        dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } })
}

/** A picture the viewer can show: a sent attachment (url) or a file still waiting in the composer (path). */
internal data class ViewerPhoto(val name: String, val url: String? = null, val path: String? = null)

/** The pictures of one message (or one draft) and the one to open first. */
internal data class PhotoSet(val photos: List<ViewerPhoto>, val start: Int)

internal fun photoSet(images: List<Attachment>, start: Int) =
    PhotoSet(images.map { ViewerPhoto(it.name, url = it.url) }, start.coerceIn(0, (images.size - 1).coerceAtLeast(0)))

/** Full-screen pictures. Several become a carousel: swipe left/right, with "2 of 5" at the top. Pinch to zoom one picture. */
@Composable
internal fun ImageViewerDialog(set: PhotoSet, onDismiss: () -> Unit) {
    val count = set.photos.size
    if (count == 0) return
    val pager = rememberPagerState(initialPage = set.start.coerceIn(0, count - 1)) { count }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            HorizontalPager(pager, Modifier.fillMaxSize(), beyondViewportPageCount = 1, key = { it }) { page -> ZoomablePhoto(set.photos[page]) }
            val current = set.photos[pager.currentPage.coerceIn(0, count - 1)]
            Row(Modifier.fillMaxWidth().statusBarsPadding().background(Color.Black.copy(alpha = 0.4f)).padding(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(start = 8.dp)) {
                    Text(current.name, color = Color.White, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                    if (count > 1) Text("${pager.currentPage + 1} of $count", color = Color.White.copy(alpha = 0.75f), style = MaterialTheme.typography.labelSmall)
                }
                TextButton(onClick = onDismiss) { Text("Close ✕", color = Color.White) }
            }
        }
    }
}

/** One page of the viewer. One finger swipes to the next picture; two fingers zoom, and a zoomed picture pans instead. */
@Composable
private fun ZoomablePhoto(p: ViewerPhoto) {
    val image = if (p.url != null) rememberRemoteImage(p.url, 2048) else rememberLocalImage(p.path, 2048)
    var scale by remember(p) { mutableStateOf(1f) }
    var offset by remember(p) { mutableStateOf(Offset.Zero) }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (image != null) Image(image, contentDescription = p.name, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()
            .pointerInput(p) {
                awaitEachGesture {
                    awaitFirstDown(requireUnconsumed = false)
                    do {
                        val event = awaitPointerEvent()
                        if (event.changes.size > 1 || scale > 1f) {
                            scale = (scale * event.calculateZoom()).coerceIn(1f, 5f)
                            offset = if (scale <= 1f) Offset.Zero else offset + event.calculatePan()
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } while (event.changes.any { it.pressed })
                }
            }
            .graphicsLayer(scaleX = scale, scaleY = scale, translationX = offset.x, translationY = offset.y))
        else Text("Loading photo…", color = Color.White)
    }
}
