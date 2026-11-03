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
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    var focusTick by remember { mutableStateOf(0) }
    // After "Mention person" or "Tag item" in the sheet, put the cursor back in the box with the keyboard up.
    LaunchedEffect(focusTick) { if (focusTick > 0) { delay(150); runCatching { focus.requestFocus() }; keyboard?.show() } }

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
    fun takePhoto() {
        if (ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) launchCamera() else cameraPermission.launch(Manifest.permission.CAMERA)
    }
    Column(Modifier.fillMaxWidth()) {
        if (panel != null) SuggestionPanel(panel, allowChannelMention, Modifier.weight(1f, fill = false),
            onUser = { u -> val (d, c) = draft.insert(panel, "@" + u.displayName, ChatTokens.userToken(u.id)); draft = d; value = TextFieldValue(d.text, TextRange(c)); rt.drafts[draftKey] = d },
            onRef = { r -> val (d, c) = draft.insert(panel, r.title, ChatTokens.objectToken(r.type, r.id)); draft = d; value = TextFieldValue(d.text, TextRange(c)); rt.drafts[draftKey] = d },
            onChannel = { val (d, c) = draft.insert(panel, "@channel", ChatTokens.CHANNEL); draft = d; value = TextFieldValue(d.text, TextRange(c)); rt.drafts[draftKey] = d },
            onDismiss = { dismissedAt = panel.start })
        Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 6.dp)) {
                if (editing != null) Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Editing message", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    ChatIconButton(ChatIcons.Close, "Cancel editing", onCancelEdit, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (attachments.isNotEmpty()) LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(start = 8.dp, end = 8.dp, bottom = 6.dp)) {
                    items(attachments, key = { it.path }) { a -> StagedAttachment(a) { attachments = attachments - a; runCatching { File(a.path).delete(); a.thumbPath?.let { File(it).delete() } } } }
                }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
                    if (editing == null) ChatIconButton(ChatIcons.Add, "Attach or tag", { menu = true }, enabled = !busy, tint = MaterialTheme.colorScheme.primary)
                    else Spacer(Modifier.width(8.dp))
                    MessageField(value, { update(it) }, placeholder, LabelHighlight(draft.labels(), MaterialTheme.colorScheme.primary), Modifier.weight(1f).padding(horizontal = 4.dp).focusRequester(focus))
                    val body = draft.toBody()
                    val canSend = (draft.hasContent() || attachments.isNotEmpty()) && body.length <= ChatTokens.MAX_BODY && !busy
                    SendButton(editing != null, canSend) {
                        onSend(body, attachments)
                        draft = ComposerDraft(); value = TextFieldValue(""); attachments = emptyList(); rt.drafts.remove(draftKey)
                    }
                }
                if (draft.toBody().length > ChatTokens.MAX_BODY - 500) Text("${draft.toBody().length} / ${ChatTokens.MAX_BODY}", style = MaterialTheme.typography.labelSmall,
                    color = if (draft.toBody().length > ChatTokens.MAX_BODY) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 64.dp, top = 2.dp))
            }
        }
    }
    if (menu) AttachSheet(onDismiss = { menu = false },
        onPhoto = { menu = false; photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
        onCamera = { menu = false; takePhoto() },
        onDocument = { menu = false; documents.launch(AttachmentRules.OPEN_DOCUMENT_TYPES) },
        onMention = { menu = false; dismissedAt = -1; update(insertChar(value, '@')); focusTick++ },
        onTag = { menu = false; dismissedAt = -1; update(insertChar(value, '#')); focusTick++ })
}

/** A rounded text pill that takes the rest of the row: one-line hint, grows to five lines. */
@Composable
private fun MessageField(value: TextFieldValue, onChange: (TextFieldValue) -> Unit, placeholder: String, transform: VisualTransformation, modifier: Modifier) {
    val style = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface)
    BasicTextField(value = value, onValueChange = onChange, modifier = modifier.heightIn(min = 48.dp).semantics { contentDescription = placeholder },
        textStyle = style, maxLines = 5, visualTransformation = transform, cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        decorationBox = { inner ->
            Box(Modifier.clip(RoundedCornerShape(24.dp)).background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f))
                .heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 12.dp), contentAlignment = Alignment.CenterStart) {
                if (value.text.isEmpty()) Text(placeholder, style = style, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                inner()
            }
        })
}

/** A round send (or save) button; grey and inert until there is something to send. */
@Composable
private fun SendButton(editing: Boolean, enabled: Boolean, onClick: () -> Unit) {
    val bg = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)
    val fg = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    Box(Modifier.size(48.dp).clip(CircleShape).background(bg)
        .clickable(enabled = enabled, role = Role.Button, onClickLabel = if (editing) "Save changes" else "Send", onClick = onClick)
        .semantics { contentDescription = if (editing) "Save changes" else "Send" }, contentAlignment = Alignment.Center) {
        Icon(if (editing) ChatIcons.Check else ChatIcons.Send, contentDescription = null, tint = fg, modifier = Modifier.size(22.dp).padding(start = if (editing) 0.dp else 2.dp))
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttachSheet(onDismiss: () -> Unit, onPhoto: () -> Unit, onCamera: () -> Unit, onDocument: () -> Unit, onMention: () -> Unit, onTag: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.fillMaxWidth().padding(bottom = 16.dp).navigationBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Add to message", Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                ChatIconButton(ChatIcons.Close, "Close", onDismiss, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            AttachRow(ChatIcons.Photo, "Photo", "Choose from your gallery", onPhoto)
            AttachRow(ChatIcons.Camera, "Camera", "Take a new photo", onCamera)
            AttachRow(ChatIcons.Document, "Document", "PDF, Word, Excel or other file", onDocument)
            HorizontalDivider(Modifier.padding(horizontal = 24.dp, vertical = 4.dp), color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            AttachRow(ChatIcons.Mention, "Mention person", "Type @ and a name", onMention)
            AttachRow(ChatIcons.Tag, "Tag item", "A store, product, order or visit", onTag)
        }
    }
}

@Composable
private fun AttachRow(icon: ImageVector, title: String, subtitle: String, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 64.dp).padding(horizontal = 24.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Box(Modifier.size(44.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.10f)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
private fun SuggestionPanel(trigger: ComposerDraft.Trigger, allowChannel: Boolean, modifier: Modifier, onUser: (UserLite) -> Unit, onRef: (RefEntry) -> Unit, onChannel: () -> Unit, onDismiss: () -> Unit) {
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
    // Shrinks to the space left above the message box, so the box stays on screen with the keyboard up.
    Surface(modifier, color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp) {
        Column {
            HorizontalDivider(color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f))
            Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(if (trigger.char == '@') "Mention a person" else "Tag a store, item, order…", Modifier.weight(1f), style = MaterialTheme.typography.labelLarge)
                ChatIconButton(ChatIcons.Close, "Close suggestions", onDismiss, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (trigger.char == '#') LazyRow(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(horizontal = 12.dp)) {
                item { FilterChip(selected = typeFilter == null, onClick = { typeFilter = null }, label = { Text("All") }, colors = chipColors()) }
                items(ChatTokens.OBJECT_TYPES) { t -> FilterChip(selected = typeFilter == t, onClick = { typeFilter = t }, label = { Text(ChatTokens.typeLabel(t)) }, colors = chipColors()) }
            }
            LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 280.dp)) {
                if (trigger.char == '@' && allowChannel && "channel".startsWith(trigger.query.lowercase()))
                    item { SuggestionRow(onChannel, { ConversationAvatar(null, emptySet(), 36.dp, "@") }, "@channel", "Notify everyone in this conversation") }
                if (trigger.char == '@') items(people, key = { it.id }) { u ->
                    SuggestionRow({ onUser(u) }, { Avatar(u, 36.dp) }, u.displayName, u.roleLabel?.replaceFirstChar { it.uppercase() } ?: if (u.isAgent) "AI user" else null, ai = u.isAgent)
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
        }
    }
}

@Composable
private fun chipColors() = FilterChipDefaults.filterChipColors(
    selectedContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), selectedLabelColor = MaterialTheme.colorScheme.primary)

@Composable
private fun SuggestionRow(onClick: () -> Unit, lead: @Composable () -> Unit, title: String, subtitle: String?, ai: Boolean = false) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
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
