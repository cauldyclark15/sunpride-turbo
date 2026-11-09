package com.sunpride.van.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.runtime.saveable.rememberSaveable

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.dp

/** IP-LOOK: pill buttons, rounded cards. Handheld buttons/fields stay at least 56dp. */
@Composable fun PrimaryBottomButton(label: String, onClick: () -> Unit, enabled: Boolean = true, tag: String = "primary") {
    PillButton(label, onClick, Modifier.testTag(tag), enabled = enabled, height = 56.dp, fontSize = 18.sp)
}
@Composable fun SecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    PillButton(label, onClick, modifier, enabled = enabled, filled = false, height = 56.dp, fontSize = 17.sp)
}
/** A destructive but allowed action (void, cancel): outlined pill with alert-red text, so it never competes with the main action. */
@Composable fun DangerButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val shape = RoundedCornerShape(Look.pill + 8.dp)
    Box(modifier.fillMaxWidth().heightIn(min = 52.dp).clip(shape).background(Look.sheet).border(1.5.dp, if (enabled) SunprideTokens.emptyRed else Look.hairline, shape)
        .clickable(enabled = enabled, onClick = onClick, role = androidx.compose.ui.semantics.Role.Button), contentAlignment = Alignment.Center) {
        FitText(label, 17.sp, Modifier.padding(horizontal = 16.dp), minSize = 13.sp, color = if (enabled) SunprideTokens.emptyRed else MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
    }
}
@Composable fun SectionCard(label: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(Look.cardRadius),
        color = Look.sheet, tonalElevation = 0.dp,
        border = BorderStroke(1.dp, Look.hairline), shadowElevation = 1.dp) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}
@Composable fun ListRow(title: String, meta: String = "", tag: String = "", enabled: Boolean = true, onClick: (() -> Unit)? = null, glyph: GlyphKind? = null) {
    Surface(Modifier.fillMaxWidth().testTag(tag), color = Look.card,
        shape = RoundedCornerShape(18.dp), border = BorderStroke(1.dp, Look.hairline)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).then(if (onClick != null) Modifier.clickable(enabled = enabled,onClick = onClick) else Modifier)
            .padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (glyph != null) Box(Modifier.size(40.dp).clip(CircleShape).background(if (enabled) Look.tint else MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                Glyph(glyph, if (enabled) Look.accent else MaterialTheme.colorScheme.onSurfaceVariant, 22.dp)
            }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (onClick != null && enabled) Glyph(GlyphKind.CHEVRON, Look.muted, 20.dp)
        }
    }
}
/** A row of equal pills where exactly one is chosen (a mode switch). The chosen one is dark and filled. */
@Composable fun SegmentedChips(options: List<Pair<String, String>>, selected: String, onSelect: (String) -> Unit, tag: String) {
    Row(Modifier.fillMaxWidth().testTag(tag), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        options.forEach { (id, label) ->
            val on = id == selected
            Surface(Modifier.weight(1f).heightIn(min = 48.dp).clip(CircleShape).clickable { onSelect(id) }.testTag("$tag-$id"), shape = CircleShape,
                color = if (on) Look.barInk else Look.sheet, border = BorderStroke(1.5.dp, if (on) Look.barInk else Look.hairline)) {
                Box(Modifier.padding(horizontal = 8.dp).heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
                    FitText(label, 16.sp, minSize = 12.sp, color = if (on) Color.White else Look.ink, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                }
            }
        }
    }
}
/** SP-0125 show/hide password eye; [crossed] draws the slash shown while the password is visible. */
@Composable fun EyeGlyph(crossed: Boolean, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(modifier.size(24.dp)) {
        val unit = size.width / 22f
        val stroke = Stroke(width = 1.8f * unit, cap = StrokeCap.Round)
        drawArc(color, startAngle = 200f, sweepAngle = 140f, useCenter = false,
            topLeft = Offset(1.5f * unit, 4.5f * unit), size = Size(19f * unit, 19f * unit), style = stroke)
        drawArc(color, startAngle = 20f, sweepAngle = 140f, useCenter = false,
            topLeft = Offset(1.5f * unit, -1.5f * unit), size = Size(19f * unit, 19f * unit), style = stroke)
        drawCircle(color, radius = 3f * unit, center = Offset(11f * unit, 11f * unit))
        if (crossed) drawLine(color, Offset(3.5f * unit, 3.5f * unit), Offset(18.5f * unit, 18.5f * unit),
            strokeWidth = 1.8f * unit, cap = StrokeCap.Round)
    }
}
/** Accessible label of the password eye: what pressing it does. */
fun passwordToggleLabel(revealed: Boolean): String = if (revealed) "Hide password" else "Show password"
/** [onToggleReveal] adds the eye button to a password field; the caller owns [revealed] (never saved). */
@Composable fun LabeledField(label: String, value: String, onChange: (String) -> Unit, tag: String,
    numeric: Boolean = false, password: Boolean = false, enabled: Boolean = true, maxLength: Int = 300,
    revealed: Boolean = false, onToggleReveal: (() -> Unit)? = null, keyboardType: KeyboardType? = null) {
    OutlinedTextField(value, { if (it.length <= maxLength) onChange(it) }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag),
        label = { Text(label) }, singleLine = true, enabled = enabled,
        visualTransformation = if (password && !revealed) PasswordVisualTransformation() else VisualTransformation.None,
        trailingIcon = if (password && onToggleReveal != null) ({
            val description = passwordToggleLabel(revealed)
            IconButton(onToggleReveal, Modifier.size(56.dp).testTag("$tag-toggle").semantics { contentDescription = description }) {
                EyeGlyph(crossed = revealed)
            }
        }) else null,
        keyboardOptions = KeyboardOptions(keyboardType = keyboardType ?: when { password -> KeyboardType.Password; numeric -> KeyboardType.Decimal; tag == "email" -> KeyboardType.Email; else -> KeyboardType.Text }),
        shape = RoundedCornerShape(Look.pill), textStyle = MaterialTheme.typography.bodyLarge,
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = Look.accent,
            unfocusedBorderColor = Look.hairline,
            focusedLabelColor = MaterialTheme.colorScheme.onSurface,
            disabledTextColor = MaterialTheme.colorScheme.onSurface,
            disabledLabelColor = MaterialTheme.colorScheme.onSurfaceVariant,
            disabledBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = .5f)))
}
@Composable fun ReasonPicker(reasons: List<String>, value: String?, onSelect: (String) -> Unit, tag: String = "reason") {
    var expanded by remember { mutableStateOf(false) }
    Box {
        SecondaryButton(value?.let(VanRules::reasonLabel) ?: "Choose a reason", { expanded = true }, Modifier.testTag(tag))
        DropdownMenu(expanded,onDismissRequest = { expanded = false }) {
            reasons.forEach { code -> DropdownMenuItem(text = { Text(VanRules.reasonLabel(code),style = MaterialTheme.typography.bodyLarge) },
                onClick = { onSelect(code); expanded = false }, modifier = Modifier.heightIn(min = 56.dp).testTag("$tag-$code")) }
        }
    }
}
@Composable fun Confirmation(label: String, value: Boolean, onChange: (Boolean) -> Unit, tag: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable { onChange(!value) }.testTag(tag), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(value,onCheckedChange = null, colors = CheckboxDefaults.colors(checkedColor = MaterialTheme.colorScheme.secondary))
        Text(label,Modifier.weight(1f).padding(end = 8.dp), style = MaterialTheme.typography.bodyLarge)
    }
}
@Composable fun ScreenFrame(title: String, onBack: (() -> Unit)? = null, action: String? = null,
    onAction: () -> Unit = {}, enabled: Boolean = true, actionTag: String = "primary", footer: String? = null,
    message: String? = null, scroll: Boolean = true, bottomContent: (@Composable ColumnScope.() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null, subtitle: String? = null,
    content: @Composable ColumnScope.() -> Unit) {
    Scaffold(Modifier.fillMaxSize().imePadding(), containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.systemBars,
        topBar = { LookTopBar(title, onBack, subtitle = subtitle, trailing = trailing) }, bottomBar = {
            // With the bottom bar showing, the action bar is a flat strip (no second rounded sheet stacked on the bar); alone, it is the raised sheet.
            val withNav = LocalNavBarShown.current
            if (action != null || footer != null || bottomContent != null) Surface(color = Look.sheet, shadowElevation = if (withNav) 0.dp else 8.dp,
                shape = if (withNav) RoundedCornerShape(0.dp) else RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop), border = if (withNav) BorderStroke(1.dp, Look.hairline) else null) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = if (withNav) 8.dp else 12.dp),verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Thumb-zone controls (e.g. POS search) sit just above the pinned primary and the navigation bar.
                    bottomContent?.invoke(this)
                    footer?.let { Text(it,style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("sync-line")) }
                    action?.let { PrimaryBottomButton(it,onAction,enabled,actionTag) }
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)
            .then(if (scroll) Modifier.verticalScroll(rememberScrollState()) else Modifier).padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
            message?.let { Text(it, style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("message")) }
            content()
        }
    }
}


// ---- Add / Edit / multi-select kit (docs/ui-actions.md). Words: Add / Edit / Save / Cancel / Remove only. ----

/** Bottom padding a list needs so its last row can scroll clear of [AddFab]. */
val AddFabListPadding = 88.dp

/**
 * The one big "Add <thing>" button of a list screen. Call it inside the Box that holds the list: it pins itself
 * bottom-end, above the bottom navigation (the host Scaffold already sizes content above it), the system bars and the
 * keyboard. Give the list `contentPadding` bottom [AddFabListPadding].
 */
@Composable
fun BoxScope.AddFab(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tag: String = "add-fab") {
    ExtendedFloatingActionButton(onClick = onClick,
        modifier = modifier.align(Alignment.BottomEnd)
            .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime)
                .only(WindowInsetsSides.Bottom + WindowInsetsSides.End))
            .padding(16.dp).heightIn(min = 56.dp).testTag(tag)
            // The full label is the button's accessible name; the "+" glyph is decoration.
            .semantics { contentDescription = label },
        shape = RoundedCornerShape(28.dp),
        containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary,
        text = { Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1) },
        icon = { Text("+", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold,
            modifier = Modifier.clearAndSetSemantics {}) })
}

/** Which rows are picked for a bulk action. Long-press a row to start; tap toggles while anything is picked. */
class Selection<K>(private val read: () -> Set<K>, private val write: (Set<K>) -> Unit) {
    val ids: Set<K> get() = read()
    val count: Int get() = read().size
    val active: Boolean get() = read().isNotEmpty()
    operator fun contains(id: K): Boolean = id in read()
    fun toggle(id: K) { val now = read(); write(if (id in now) now - id else now + id) }
    fun clear() = write(emptySet())
}

/** A [Selection] that survives recomposition and rotation (ids must be saveable: String, Long, Int). */
@Composable
fun <K : Any> rememberSelection(): Selection<K> {
    val state = rememberSaveable { mutableStateOf(emptyList<Any>()) }
    @Suppress("UNCHECKED_CAST")
    return Selection(read = { (state.value as List<K>).toSet() }, write = { state.value = it.toList() })
}

/** Row click wiring for multi-select: long-press picks, tap toggles while picking, otherwise [onOpen]. */
@OptIn(ExperimentalFoundationApi::class)
fun <K> Modifier.selectableRow(selection: Selection<K>, id: K, onOpen: () -> Unit): Modifier =
    this.combinedClickable(
        onClick = { if (selection.active) selection.toggle(id) else onOpen() },
        onLongClick = { selection.toggle(id) })

/**
 * The bar that replaces a list's top row while rows are picked: "N selected", the bulk [actions], and Cancel
 * ([onClear]). Shows nothing when [count] is 0.
 */
@Composable
fun SelectBar(count: Int, actions: List<Pair<String, () -> Unit>>, onClear: () -> Unit, modifier: Modifier = Modifier) {
    if (count <= 0) return
    Surface(modifier.fillMaxWidth().testTag("select-bar"), color = MaterialTheme.colorScheme.inverseSurface,
        contentColor = MaterialTheme.colorScheme.inverseOnSurface, shape = RoundedCornerShape(20.dp)) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text("$count selected", style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f).testTag("select-count"))
            actions.forEach { (label, run) ->
                TextButton(onClick = run, modifier = Modifier.heightIn(min = 48.dp).testTag("select-action-$label")) {
                    Text(label, color = MaterialTheme.colorScheme.inverseOnSurface, style = MaterialTheme.typography.labelLarge)
                }
            }
            TextButton(onClick = onClear, modifier = Modifier.heightIn(min = 48.dp).testTag("select-cancel")) {
                Text("Cancel", color = MaterialTheme.colorScheme.inverseOnSurface, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}
