package com.sunpride.chat.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.clickable
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.sunpride.chat.AttachmentPrep
import com.sunpride.chat.AttachmentRules
import com.sunpride.chat.ChatErrors
import com.sunpride.chat.ChatMessage
import com.sunpride.chat.ChatTokens
import com.sunpride.chat.ComposerDraft
import com.sunpride.chat.FileOpener
import com.sunpride.chat.LocalAttachment
import com.sunpride.chat.RefEntry
import com.sunpride.chat.UserLite
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

private class LabelHighlight(private val labels: List<String>, private val color: Color) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val styled = buildAnnotatedString {
            append(text.text)
            for (l in labels) {
                var i = text.text.indexOf(l)
                while (i >= 0) { addStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold), i, i + l.length); i = text.text.indexOf(l, i + l.length) }
            }
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }
}

/** The message box: @ people, # objects, photos, files; shows names, sends canonical tokens. */
@Composable
internal fun ChatComposer(
    draftKey: String,
    editing: ChatMessage?,
    placeholder: String,
    allowChannelMention: Boolean,
    onSend: (body: String, attachments: List<LocalAttachment>) -> Unit,
    onCancelEdit: () -> Unit,
    onNotice: (String) -> Unit,
) {
    val rt = LocalChat.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var draft by remember(draftKey, editing?.id) { mutableStateOf(if (editing != null) ComposerDraft.fromBody(editing.body, editing.refs) else rt.drafts[draftKey] ?: ComposerDraft()) }
    var value by remember(draftKey, editing?.id) { mutableStateOf(TextFieldValue(draft.text, TextRange(draft.text.length))) }
    var attachments by remember(draftKey) { mutableStateOf(emptyList<LocalAttachment>()) }
    var dismissedAt by remember(draftKey) { mutableStateOf(-1) }
    var menu by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }

    fun update(v: TextFieldValue) {
        draft = draft.withText(v.text); value = v
        if (editing == null) rt.drafts[draftKey] = draft
    }
    fun stage(uri: Uri) {
        scope.launch {
            if (attachments.size >= AttachmentRules.MAX_PER_MESSAGE) { onNotice("You can attach up to 10 files to one message."); return@launch }
            busy = true
            try {
                val a = withContext(Dispatchers.IO) { AttachmentPrep.fromUri(ctx, uri, rt.filesDir) }
                attachments = attachments + a
            } catch (e: AttachmentPrep.Rejected) { onNotice(e.message ?: "That file can't be sent.") }
            catch (e: Exception) { onNotice("That file couldn't be read.") }
            busy = false
        }
    }
    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(5)) { uris -> uris.forEach(::stage) }
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris -> uris.forEach(::stage) }
    var cameraFile by rememberSaveable { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        val f = cameraFile?.let(::File)
        if (ok && f != null && f.length() > 0) scope.launch {
            busy = true
            try {
                attachments = attachments + withContext(Dispatchers.IO) {
                    val kept = File(rt.filesDir, f.name); f.copyTo(kept, true); f.delete()
                    AttachmentPrep.fromFile(kept, "photo-" + java.time.LocalDateTime.now().format(java.time.format.DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss")) + ".jpg", "image/jpeg")
                }
            } catch (e: Exception) { onNotice("The photo couldn't be saved.") }
            busy = false
        } else f?.delete()
    }
    fun launchCamera() {
        val dir = File(ctx.cacheDir, "chat-camera").apply { mkdirs() }
        val f = File(dir, "photo-" + java.util.UUID.randomUUID().toString().take(8) + ".jpg")
        cameraFile = f.path
        camera.launch(FileProvider.getUriForFile(ctx, FileOpener.authority(ctx), f))
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) launchCamera() else onNotice("Allow camera access in the phone's Settings to take photos here.")
    }

    val cursor = value.selection.start
    val trigger = if (value.selection.collapsed) draft.triggerAt(cursor) else null
    val panel = trigger?.takeIf { it.start != dismissedAt }

    // Back closes the suggestion list first, then cancels an edit, before it leaves the screen.
    androidx.activity.compose.BackHandler(enabled = panel != null || editing != null) { if (panel != null) dismissedAt = panel.start else onCancelEdit() }
    Column(Modifier.fillMaxWidth()) {
        if (panel != null) SuggestionPanel(panel, allowChannelMention,
            onUser = { u -> val (d, c) = draft.insert(panel, "@" + u.displayName, ChatTokens.userToken(u.id)); draft = d; value = TextFieldValue(d.text, TextRange(c)); rt.drafts[draftKey] = d },
            onRef = { r -> val (d, c) = draft.insert(panel, r.title, ChatTokens.objectToken(r.type, r.id)); draft = d; value = TextFieldValue(d.text, TextRange(c)); rt.drafts[draftKey] = d },
            onChannel = { val (d, c) = draft.insert(panel, "@channel", ChatTokens.CHANNEL); draft = d; value = TextFieldValue(d.text, TextRange(c)); rt.drafts[draftKey] = d },
            onDismiss = { dismissedAt = panel.start })
        Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 3.dp) {
            Column(Modifier.padding(horizontal = 8.dp, vertical = 6.dp)) {
                if (editing != null) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Editing message", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    TextButton(onClick = onCancelEdit) { Text("Cancel") }
                }
                if (attachments.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                    items(attachments, key = { it.path }) { a -> StagedAttachment(a) { attachments = attachments - a; runCatching { File(a.path).delete(); a.thumbPath?.let { File(it).delete() } } } }
                }
                Row(verticalAlignment = Alignment.Bottom) {
                    if (editing == null) {
                        TextButton(onClick = { menu = true }, enabled = !busy, modifier = Modifier.semantics { contentDescription = "Attach a photo or file" }) { Text("＋", style = MaterialTheme.typography.titleLarge) }
                        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Take a photo") }, onClick = {
                                menu = false
                                if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera() else cameraPermission.launch(Manifest.permission.CAMERA)
                            })
                            DropdownMenuItem(text = { Text("Choose photos") }, onClick = { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) })
                            DropdownMenuItem(text = { Text("Attach a document") }, onClick = { menu = false; documents.launch(AttachmentRules.OPEN_DOCUMENT_TYPES) })
                        }
                    }
                    TextButton(onClick = { update(insertChar(value, '@')) }, modifier = Modifier.semantics { contentDescription = "Mention a person" }) { Text("@", style = MaterialTheme.typography.titleMedium) }
                    TextButton(onClick = { update(insertChar(value, '#')) }, modifier = Modifier.semantics { contentDescription = "Tag a store, item or order" }) { Text("#", style = MaterialTheme.typography.titleMedium) }
                    OutlinedTextField(value = value, onValueChange = { update(it) }, modifier = Modifier.weight(1f), maxLines = 5,
                        placeholder = { Text(placeholder) }, visualTransformation = LabelHighlight(draft.labels(), MaterialTheme.colorScheme.primary))
                    val body = draft.toBody()
                    val canSend = (draft.hasContent() || attachments.isNotEmpty()) && body.length <= ChatTokens.MAX_BODY && !busy
                    TextButton(onClick = {
                        onSend(body, attachments)
                        draft = ComposerDraft(); value = TextFieldValue(""); attachments = emptyList(); rt.drafts.remove(draftKey)
                    }, enabled = canSend, modifier = Modifier.semantics { contentDescription = if (editing != null) "Save changes" else "Send" }) {
                        Text(if (editing != null) "Save" else "Send", style = MaterialTheme.typography.titleSmall)
                    }
                }
                if (draft.toBody().length > ChatTokens.MAX_BODY - 500) Text("${draft.toBody().length} / ${ChatTokens.MAX_BODY}", style = MaterialTheme.typography.labelSmall,
                    color = if (draft.toBody().length > ChatTokens.MAX_BODY) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 16.dp))
            }
        }
    }
}

private fun insertChar(v: TextFieldValue, c: Char): TextFieldValue {
    val at = v.selection.start.coerceIn(0, v.text.length)
    val needsSpace = at > 0 && !v.text[at - 1].isWhitespace()
    val ins = (if (needsSpace) " " else "") + c
    return TextFieldValue(v.text.substring(0, at) + ins + v.text.substring(v.selection.end.coerceIn(at, v.text.length)), TextRange(at + ins.length))
}

/** Matching people (after @) or objects with thumbnails (after #), above the keyboard. */
@Composable
private fun SuggestionPanel(trigger: ComposerDraft.Trigger, allowChannel: Boolean, onUser: (UserLite) -> Unit, onRef: (RefEntry) -> Unit, onChannel: () -> Unit, onDismiss: () -> Unit) {
    val repo = LocalChat.current.repository
    var people by remember { mutableStateOf(emptyList<UserLite>()) }
    var refs by remember { mutableStateOf(emptyList<RefEntry>()) }
    var typeFilter by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(trigger.char, trigger.query, typeFilter) {
        loading = true; delay(200)
        try {
            problem = null
            if (trigger.char == '@') people = repo.searchPeople(trigger.query)
            else refs = repo.searchRefs(trigger.query, typeFilter?.let { listOf(it) } ?: ChatTokens.OBJECT_TYPES)
        } catch (e: com.sunpride.chat.ChatException) { problem = ChatErrors.words(e) }
        loading = false
    }
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 6.dp, shadowElevation = 4.dp) {
        Column {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (trigger.char == '@') "Mention a person" else "Tag a store, item, order…", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                TextButton(onClick = onDismiss) { Text("Close") }
            }
            if (trigger.char == '#') LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(horizontal = 12.dp)) {
                item { FilterChip(selected = typeFilter == null, onClick = { typeFilter = null }, label = { Text("All") }) }
                items(ChatTokens.OBJECT_TYPES) { t -> FilterChip(selected = typeFilter == t, onClick = { typeFilter = t }, label = { Text(ChatTokens.typeLabel(t)) }) }
            }
            LazyColumn(Modifier.heightIn(max = 260.dp)) {
                if (trigger.char == '@' && allowChannel && "channel".startsWith(trigger.query.lowercase()))
                    item { SuggestionRow(onChannel, { Text("📣") }, "@channel", "Notify everyone in this conversation") }
                if (trigger.char == '@') items(people, key = { it.id }) { u ->
                    SuggestionRow({ onUser(u) }, { Avatar(u, 36.dp) }, u.displayName, u.roleLabel ?: if (u.isAgent) "AI user" else null, ai = u.isAgent)
                } else items(refs, key = { it.type + it.id }) { r ->
                    SuggestionRow({ onRef(r) }, { RefThumb(r, r.type, 40.dp) }, r.title, listOfNotNull(ChatTokens.typeLabel(r.type), r.subtitle).joinToString(" · "))
                }
                item {
                    val empty = if (trigger.char == '@') people.isEmpty() else refs.isEmpty()
                    if (problem != null) Text(problem!!, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                    else if (loading && empty) Text("Searching…", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
                    else if (empty) Text("No matches", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
                }
            }
            HorizontalDivider()
        }
    }
}

@Composable
private fun SuggestionRow(onClick: () -> Unit, lead: @Composable () -> Unit, title: String, subtitle: String?, ai: Boolean = false) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        lead()
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (ai) { androidx.compose.foundation.layout.Spacer(Modifier.padding(start = 6.dp)); AiBadge() }
            }
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
