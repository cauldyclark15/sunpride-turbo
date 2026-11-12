package com.sunpride.chat.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sunpride.chat.Attachment
import com.sunpride.chat.ChatErrors
import com.sunpride.chat.ChatException
import com.sunpride.chat.ChatFormat
import com.sunpride.chat.ChatMessage
import com.sunpride.chat.ChatRow
import com.sunpride.chat.ChatTokens
import com.sunpride.chat.Conversation
import com.sunpride.chat.ConversationSection
import com.sunpride.chat.FileOpener
import com.sunpride.chat.MessageLayout
import com.sunpride.chat.Segment
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal fun toast(context: Context, text: String) { Toast.makeText(context, text, Toast.LENGTH_LONG).show() }

@Composable
internal fun ConversationListScreen(showBar: Boolean = true, onClose: () -> Unit, onOpen: (String) -> Unit, onNew: () -> Unit, onSearch: () -> Unit) {
    val repo = LocalChat.current.repository
    val state by repo.conversations.collectAsState()
    val me by repo.myIds.collectAsState()
    val unread by repo.unread.collectAsState()
    val now = System.currentTimeMillis()
    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            if (showBar) ChatTopBar("Messages", onClose, subtitle = if (unread.total > 0) "${unread.total} unread" else null)
            SearchEntry(onSearch)
            if (state.offline) Banner("You're offline. Showing your saved conversations.")
            state.error?.let { Banner(it, error = true) }
            if (state.items.isEmpty()) {
                Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    if (state.loaded) EmptyIcon()
                    Text(if (!state.loaded) "Loading your conversations…" else "No conversations yet", Modifier.padding(top = 16.dp),
                        style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
                    if (state.loaded) Text("Tap the pencil to message a person, a group or a channel.", Modifier.padding(top = 4.dp),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                }
            } else LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                ConversationSection.entries.forEach { section ->
                    val items = state.items.filter { ChatFormat.sectionOf(it, me) == section }
                    if (items.isNotEmpty()) {
                        item(key = "h-${section.name}") {
                            Text(section.title.uppercase(), Modifier.fillMaxWidth().padding(start = 16.dp, top = 16.dp, bottom = 4.dp), style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = FontWeight.SemiBold, letterSpacing = 0.8.sp)
                        }
                        items(items, key = { it.id }) { c -> ConversationRow(c, me, now) { onOpen(c.id) } }
                    }
                }
            }
        }
        FloatingActionButton(onClick = onNew, modifier = Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(16.dp),
            containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary) {
            Icon(ChatIcons.NewChat, contentDescription = "New conversation")
        }
    }
}

/** Looks like a search box; opens the message search. */
@Composable
private fun SearchEntry(onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).clip(RoundedCornerShape(24.dp))
        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f)).clickable(onClickLabel = "Search messages", onClick = onClick)
        .heightIn(min = 48.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Icon(ChatIcons.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        Text("Search messages", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
    }
}

@Composable
internal fun EmptyIcon() {
    Box(Modifier.size(72.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
        Icon(ChatIcons.Chat, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(34.dp))
    }
}

@Composable
private fun ConversationRow(c: Conversation, me: Set<String>, now: Long, onClick: () -> Unit) {
    val title = ChatFormat.title(c, me)
    val unread = c.unreadCount > 0
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        ConversationAvatar(c, me, 48.dp, title)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
              Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false))
                if (c.hasAgent && c.isDm) { Spacer(Modifier.width(6.dp)); AiBadge() }
                if (c.isChannel && c.isPrivate) { Spacer(Modifier.width(4.dp)); Icon(ChatIcons.Lock, contentDescription = "Private", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp)) }
                if (c.muted) { Spacer(Modifier.width(4.dp)); Icon(ChatIcons.Muted, contentDescription = "Muted", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp)) }
              }
                Spacer(Modifier.width(8.dp))
                Text(ChatFormat.listTime(com.sunpride.chat.parseIsoMillis(c.lastMessage?.createdAt ?: c.updatedAt), now), style = MaterialTheme.typography.labelSmall,
                    color = if (unread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(ChatFormat.lastLine(c, me).replace('\n', ' '), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant, fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal)
                if (c.mentionCount > 0) CountBadge(c.mentionCount, mention = true)
                if (c.unreadCount > 0) CountBadge(c.unreadCount)
            }
        }
    }
}

private val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "🎉", "😮", "🙏")

/** A conversation, or one thread inside it when [parentId] is set. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationScreen(
    conversationId: String, parentId: String?, onBack: () -> Unit, onOpenThread: (String) -> Unit, onDetails: () -> Unit, onViewImage: (List<Attachment>, Int) -> Unit,
) {
    val rt = LocalChat.current
    val env = LocalChatEnv.current
    val repo = rt.repository
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val st by repo.state(conversationId, parentId).collectAsState()
    val mainState by repo.state(conversationId).collectAsState()
    val convs by repo.conversations.collectAsState()
    val me by repo.myIds.collectAsState()
    val conv = convs.items.firstOrNull { it.id == conversationId }
    var firstUnread by remember(conversationId, parentId) { mutableStateOf<Long?>(null) }
    var actions by remember { mutableStateOf<ChatMessage?>(null) }
    var editing by remember { mutableStateOf<ChatMessage?>(null) }
    var deleting by remember { mutableStateOf<ChatMessage?>(null) }
    var chip by remember { mutableStateOf<Segment.ObjectChip?>(null) }

    LaunchedEffect(conversationId, parentId) {
        repo.open(conversationId, parentId)
        if (parentId == null) { firstUnread = repo.firstUnreadSeq(conversationId); repo.markRead(conversationId) }
    }
    // New messages arriving while this screen is open count as read.
    LaunchedEffect(st.messages.lastOrNull()?.seq) { if (parentId == null && st.loaded) repo.markRead(conversationId) }

    val parent = parentId?.let { id -> mainState.messages.firstOrNull { it.id == id } }
    val rows = remember(st.messages, st.pending, me, firstUnread) { MessageLayout.build(st.messages, st.pending, me, firstUnread, System.currentTimeMillis()) }
    val listState = rememberLazyListState()
    val reversed = remember(rows) { rows.asReversed() }
    var jumped by remember(conversationId, parentId) { mutableStateOf(false) }
    val dividerAt = reversed.indexOfFirst { it is ChatRow.UnreadDivider }
    LaunchedEffect(dividerAt >= 0) { if (dividerAt >= 0 && !jumped) { jumped = true; listState.scrollToItem(dividerAt) } }
    LaunchedEffect(rows.lastOrNull()?.key) { if (listState.firstVisibleItemIndex <= 2 && !(dividerAt >= 0 && !jumped)) listState.animateScrollToItem(0) }
    LaunchedEffect(st.pending.size) { if (st.pending.isNotEmpty()) listState.animateScrollToItem(0) }

    val handlers = remember(conversationId, parentId) {
        MessageHandlers(
            onLongPress = { actions = it },
            onChip = { chip = it },
            onImage = onViewImage,
            onFile = { a -> scope.launch { toast(ctx, "Opening ${a.name}…"); withContext(Dispatchers.IO) { FileOpener.open(ctx, rt.api, a) }?.let { toast(ctx, it) } } },
            onReact = { m, e -> scope.launch { try { repo.toggleReaction(m, e) } catch (x: ChatException) { toast(ctx, ChatErrors.words(x)) } } },
            onThread = { onOpenThread(it.id) },
            onRetry = { p -> repo.retry(p.clientMsgId, conversationId); scope.launch { repo.flushOutbox(force = true) } },
            onDiscard = { p -> repo.discard(p.clientMsgId, conversationId) },
        )
    }

    val convTitle = conv?.let { ChatFormat.title(it, me) } ?: "Conversation"
    val title = if (parentId != null) "Thread" else convTitle
    val subtitle = when {
        parentId != null -> convTitle
        conv == null -> null
        conv.isChannel -> conv.topic?.takeIf { it.isNotBlank() } ?: ("Channel · " + if (conv.memberCount == 1) "1 member" else "${conv.memberCount} members")
        !conv.isDm -> "Group · ${conv.memberCount} people"
        conv.membersPreview.any { it.isAgent && it.id !in me } -> "Developer"
        else -> "Direct message"
    }
    // "Say hello to Ana": the other person's first name in a DM.
    val firstName = conv?.takeIf { it.isDm }?.membersPreview?.firstOrNull { it.id !in me }?.displayName?.let(::firstNameOf)
    // The time sits under the last bubble of each run, so a run of quick messages shows it once.
    val timeShownOn = remember(rows) {
        rows.indices.filter { i ->
            val r = rows[i] as? ChatRow.Msg ?: return@filter false
            val next = rows.getOrNull(i + 1)
            next !is ChatRow.Msg || next.showHeader || next.mine != r.mine || next.message.author.id != r.message.author.id
        }.map { rows[it].key }.toSet()
    }
    Column(Modifier.fillMaxSize()) {
        ChatTopBar(title, onBack, subtitle,
            leading = if (parentId == null) ({ ConversationAvatar(conv, me, 40.dp, convTitle) }) else null,
            onTitleClick = if (parentId == null) onDetails else null,
            actions = { if (parentId == null) ChatIconButton(ChatIcons.Info, "Conversation details", onDetails, tint = MaterialTheme.colorScheme.onSurfaceVariant) })
        if (st.offline) Banner("You're offline. Showing saved messages${if (st.pending.isNotEmpty()) "; your unsent messages will go when you're back online" else ""}.")
        st.error?.let { Banner(it, error = true) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (st.messages.isEmpty() && st.pending.isEmpty() && parent == null) {
                // Sits just above the message box, where the first message will appear.
                Column(Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = 32.dp, vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    if (!st.loaded) Text("Loading messages…", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else {
                        EmptyIcon()
                        Text(if (parentId != null) "No replies yet" else "No messages yet", Modifier.padding(top = 14.dp), style = MaterialTheme.typography.titleMedium,
                            color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.Center)
                        Text(when { parentId != null -> "Reply to start the thread"; firstName != null -> "Say hello to $firstName"; else -> "Start the conversation" },
                            Modifier.padding(top = 4.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                            maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true, contentPadding = PaddingValues(top = 4.dp, bottom = 8.dp)) {
                items(reversed, key = { it.key }) { row ->
                    when (row) {
                        is ChatRow.Day -> DayRow(row.label)
                        is ChatRow.UnreadDivider -> UnreadRow(row.count)
                        is ChatRow.Msg -> MessageRowView(row, me, handlers, showThreadLink = parentId == null, showTime = row.key in timeShownOn)
                        is ChatRow.Sending -> SendingRowView(row, handlers)
                    }
                }
                if (st.hasMore) item(key = "older") {
                    LaunchedEffect(st.messages.firstOrNull()?.id) { repo.loadOlder(conversationId, parentId) }
                    Text("Loading earlier messages…", Modifier.fillMaxWidth().padding(12.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (parent != null) {
                    item(key = "thread-sep") {
                        Text(if (parent.replyCount == 1) "1 reply" else "${parent.replyCount} replies", Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        HorizontalDivider()
                    }
                    item(key = "thread-parent") { MessageRowView(ChatRow.Msg(parent, true, parent.author.id in me), me, handlers, showThreadLink = false) }
                }
            }
        }
        Box(Modifier.navigationBarsPadding()) {
            ChatComposer(
                draftKey = repoKey(conversationId, parentId), editing = editing,
                placeholder = if (parentId != null) "Reply" else "Message",
                allowChannelMention = conv?.isDm != true,
                onSend = { body, atts ->
                    val e = editing
                    if (e != null) scope.launch { try { repo.edit(e, body); editing = null } catch (x: ChatException) { toast(ctx, ChatErrors.words(x)) } }
                    else scope.launch { repo.send(conversationId, body, parentId, atts) }
                },
                onCancelEdit = { editing = null }, onNotice = { toast(ctx, it) })
        }
    }

    actions?.let { m ->
        val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
        ModalBottomSheet(onDismissRequest = { actions = null }, sheetState = sheet, containerColor = MaterialTheme.colorScheme.surface) {
            Column(Modifier.padding(bottom = 24.dp).navigationBarsPadding()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    QUICK_REACTIONS.forEach { e -> TextButton(onClick = { actions = null; handlers.onReact(m, e) }) { Text(e, style = MaterialTheme.typography.headlineSmall) } }
                }
                HorizontalDivider()
                if (parentId == null && !m.deleted) SheetAction("Reply in thread") { actions = null; onOpenThread(m.id) }
                if (!m.deleted && m.body.isNotBlank()) SheetAction("Copy text") {
                    val text = ChatTokens.plain(m.body, m.refs)
                    (ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Message", text))
                    actions = null; toast(ctx, "Copied")
                }
                if (m.author.id in me && !m.deleted) SheetAction("Edit") { actions = null; editing = m }
                if (m.author.id in me && !m.deleted) SheetAction("Delete", danger = true) { actions = null; deleting = m }
                SheetAction("Close") { actions = null }
            }
        }
    }
    deleting?.let { m ->
        AlertDialog(onDismissRequest = { deleting = null }, title = { Text("Delete this message?") }, text = { Text("It will be removed for everyone in this conversation.") },
            confirmButton = { TextButton(onClick = { deleting = null; scope.launch { try { repo.delete(m) } catch (x: ChatException) { toast(ctx, ChatErrors.words(x)) } } }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } })
    }
    chip?.let { c -> ObjectSheet(c, env.openHref) { chip = null } }
}

/** "Ana Reyes" → "Ana"; trial accounts named "Sample Ana Reyes" give "Ana" too. */
internal fun firstNameOf(displayName: String): String? {
    val words = displayName.trim().split(Regex("\\s+")).filter { it.isNotBlank() }
    val start = if (words.size > 1 && words[0].equals("Sample", ignoreCase = true)) 1 else 0
    return words.getOrNull(start)
}

private fun repoKey(conversationId: String, parentId: String?) = if (parentId == null) conversationId else "$conversationId#$parentId"

@Composable
internal fun SheetAction(label: String, danger: Boolean = false, onClick: () -> Unit) {
    Text(label, Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 24.dp, vertical = 14.dp), style = MaterialTheme.typography.bodyLarge,
        color = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
}

/** What a tapped store/item/order chip shows: its card, and a button to open it in the app where there is a screen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ObjectSheet(chip: Segment.ObjectChip, openHref: (String) -> Boolean, onDismiss: () -> Unit) {
    val ctx = LocalContext.current
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).navigationBarsPadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                RefThumb(chip.entry, chip.type, 64.dp)
                Column(Modifier.weight(1f)) {
                    Text(chip.label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                    Text(ChatTokens.typeLabel(chip.type), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                    chip.entry?.subtitle?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                ChatIconButton(ChatIcons.Close, "Close", onDismiss, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val entry = chip.entry
            when {
                entry == null -> Text("Details aren't available right now.", style = MaterialTheme.typography.bodyMedium)
                entry.restricted -> Text("You don't have access to this item.", style = MaterialTheme.typography.bodyMedium)
                entry.missing -> Text("This item has been removed.", style = MaterialTheme.typography.bodyMedium)
                entry.href != null -> {
                    Button(onClick = { if (openHref(entry.href)) onDismiss() else toast(ctx, "Open ${chip.label} in the Sunpride web app.") },
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Open") }
                }
            }
        }
    }
}
