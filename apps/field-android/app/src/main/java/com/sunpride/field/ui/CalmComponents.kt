package com.sunpride.field.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.TextButton
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable

import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.only
import androidx.compose.ui.composed

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** The account glyph used by the header and by tests that compose their own header. */
@Composable
fun AccountGlyph(color: Color = MaterialTheme.colorScheme.onSurface) {
    Glyph(GlyphKind.PERSON, color, 24.dp, Modifier.semantics { contentDescription = "Account" })
}

/** SP-0128 show/hide password eye; [crossed] draws the slash shown while the password is visible. */
@Composable
fun EyeGlyph(crossed: Boolean, modifier: Modifier = Modifier) {
    val color = MaterialTheme.colorScheme.onSurfaceVariant
    Canvas(modifier.size(22.dp)) {
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

/** A titled group: a bold sentence-case heading, then the content, inside one hairline card. */
@Composable
fun SectionCard(label: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(modifier = modifier.fillMaxWidth(), shape = SunprideTokens.shapes.large,
        color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
        border = BorderStroke(1.dp, Look.hairline)) {
        Column {
            Text(label, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp, bottom = 6.dp))
            content()
        }
    }
}

/** A heading between cards, outside any card. */
@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/**
 * SP-0140: long lists inside a LazyColumn. A heading item, then one hairline card per row, so only the rows on screen are
 * composed. Each row gets a stable [key] so scrolling and filtering reuse rows.
 */
fun <T> androidx.compose.foundation.lazy.LazyListScope.lazySectionCard(label: String, items: List<T>,
    key: (T) -> Any, headerModifier: Modifier = Modifier, row: @Composable (T) -> Unit) {
    item(key = "section-header:$label") {
        SectionTitle(label, headerModifier.padding(bottom = 4.dp))
    }
    items(items.size, key = { key(items[it]) }) { index ->
        val shape = SunprideTokens.shapes.large
        Box(Modifier.fillMaxWidth().padding(bottom = 8.dp).clip(shape)
            .background(MaterialTheme.colorScheme.surface).border(1.dp, Look.hairline, shape)) { row(items[index]) }
    }
}

/** A round tile with the stop number or the first letter of a name. */
@Composable
fun IconTile(initial: String, emphasis: Boolean = false) {
    Box(Modifier.size(40.dp).clip(CircleShape).background(if (emphasis) Look.accent else Look.tint).clearAndSetSemantics {},
        contentAlignment = Alignment.Center) {
        Text(initial, style = MaterialTheme.typography.titleSmall, color = if (emphasis) Look.onAccent else Look.onTint)
    }
}

private fun glyphFor(name: String): GlyphKind? = when (name) {
    "route" -> GlyphKind.ROUTE; "search" -> GlyphKind.SEARCH; "team" -> GlyphKind.PEOPLE; "info" -> GlyphKind.INFO
    "box" -> GlyphKind.BOX; "clock" -> GlyphKind.CLOCK; "cash" -> GlyphKind.CASH; "lock" -> GlyphKind.LOCK
    "battery" -> GlyphKind.BATTERY; "sync" -> GlyphKind.SYNC; "sliders" -> GlyphKind.SLIDERS; "person" -> GlyphKind.PERSON
    "chat" -> GlyphKind.CHAT; "phone" -> GlyphKind.PHONE; "list" -> GlyphKind.LIST; "pin" -> GlyphKind.PIN
    "shop" -> GlyphKind.STORE; "activity" -> GlyphKind.LIST; "photo" -> GlyphKind.CAMERA; "sign-out" -> GlyphKind.SIGN_OUT; "camera" -> GlyphKind.CAMERA
    else -> null
}

/**
 * One tappable (or plain) row: leading tile, title, up to two lines of detail, optional trailing text and a chevron when
 * tappable. 64 dp minimum, so the whole row is a comfortable target.
 */
@Composable
fun ListRow(title: String, meta: String, glyph: String, modifier: Modifier = Modifier,
    trailing: String? = null, onClick: (() -> Unit)? = null, tile: String? = null,
    trailingContent: (@Composable () -> Unit)? = null, emphasis: Boolean = false,
    leading: (@Composable () -> Unit)? = null) {
    Surface(onClick = onClick ?: {}, enabled = onClick != null, color = Color.Transparent,
        tonalElevation = 0.dp, modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (leading != null) leading()
            else if (glyph == "store") IconTile(tile ?: title.trim().take(1).uppercase(), emphasis)
            else glyphFor(glyph)?.let { GlyphTile(it, size = 40.dp) }
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            trailingContent?.invoke()
            if (onClick != null) Glyph(GlyphKind.CHEVRON, MaterialTheme.colorScheme.onSurfaceVariant, 20.dp)
        }
    }
}

@Composable
fun ValueRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold,
            color = MaterialTheme.colorScheme.onSurface, textAlign = TextAlign.End, modifier = Modifier.weight(1.2f))
    }
    HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = Look.hairline.copy(alpha = 0.7f))
}

@Composable
internal fun fieldColors() = OutlinedTextFieldDefaults.colors(
    focusedBorderColor = MaterialTheme.colorScheme.primary,
    unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.55f),
    disabledBorderColor = Look.hairline,
    focusedContainerColor = MaterialTheme.colorScheme.surface, unfocusedContainerColor = MaterialTheme.colorScheme.surface,
    disabledContainerColor = MaterialTheme.colorScheme.surface)

@Composable
fun LabeledField(label: String, value: String, onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default,
    trailingIcon: (@Composable () -> Unit)? = null) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 14.dp))
        OutlinedTextField(value, onValueChange, singleLine = true, enabled = enabled,
            visualTransformation = visualTransformation, keyboardOptions = keyboardOptions, trailingIcon = trailingIcon,
            modifier = modifier.fillMaxWidth().heightIn(min = 52.dp), shape = RoundedCornerShape(Look.pill),
            textStyle = MaterialTheme.typography.bodyLarge, colors = fieldColors())
    }
}

/** A pill search box with a magnifier and a hint inside it. The tag goes on the editable text. */
@Composable
fun SearchField(value: String, onValueChange: (String) -> Unit, hint: String, modifier: Modifier = Modifier,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default) {
    OutlinedTextField(value, onValueChange, singleLine = true, keyboardOptions = keyboardOptions,
        modifier = modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(Look.pill),
        textStyle = MaterialTheme.typography.bodyLarge,
        placeholder = { Text(hint, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) },
        leadingIcon = { Glyph(GlyphKind.SEARCH, MaterialTheme.colorScheme.onSurfaceVariant, 22.dp) },
        colors = fieldColors())
}

/**
 * The sync / location chip. A white pill on the red header with a status dot; [warning] turns it into the red-tinted alert.
 * [good] colours the dot green. The label is the status, so colour is never the only signal.
 */
@Composable
fun StatusPill(label: String, modifier: Modifier = Modifier, warning: Boolean = false,
    onClick: (() -> Unit)? = null, good: Boolean = false) {
    val fill = if (warning) Look.fill(Look.Tone.BAD) else MaterialTheme.colorScheme.surface
    val text = if (warning) Look.text(Look.Tone.BAD) else MaterialTheme.colorScheme.onSurface
    val dot = when {
        warning -> Look.text(Look.Tone.BAD)
        good -> Look.text(Look.Tone.GOOD)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    Surface(onClick = onClick ?: {}, enabled = onClick != null,
        modifier = modifier.heightIn(min = 32.dp).semantics(mergeDescendants = true) {}, shape = CircleShape,
        color = fill, tonalElevation = 0.dp) {
        Row(Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(8.dp).clip(CircleShape).background(dot))
            Text(label, style = MaterialTheme.typography.labelMedium, color = text, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (onClick != null) Glyph(GlyphKind.CHEVRON, text, 14.dp)
        }
    }
}

/** Outlined pill. Used for the second action next to a primary one. */
@Composable
fun SecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, danger: Boolean = false) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 52.dp),
        shape = RoundedCornerShape(Look.pill),
        border = BorderStroke(1.5.dp, if (danger) MaterialTheme.colorScheme.error.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outline),
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = MaterialTheme.colorScheme.background,
            contentColor = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            disabledContainerColor = MaterialTheme.colorScheme.background,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f))) {
        Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/** A pale red pill: the second action that still belongs to the brand (Navigate, Call). */
@Composable
fun TonalButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    glyph: GlyphKind? = null) {
    val content = if (enabled) Look.onTint else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f)
    Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 52.dp), shape = RoundedCornerShape(Look.pill),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Look.tint, contentColor = Look.onTint,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f))) {
        if (glyph != null) { Glyph(glyph, content, 20.dp); Spacer(Modifier.size(8.dp)) }
        Text(label, style = MaterialTheme.typography.labelLarge, textAlign = TextAlign.Center)
    }
}

/** The one filled action of a screen: a full-width red pill. */
@Composable
fun PrimaryBottomButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
        shape = RoundedCornerShape(Look.pill),
        colors = ButtonDefaults.buttonColors(disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
        Text(label, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
    }
}

/** What an empty list says: a tinted glyph, a plain headline and one line of what to do next. */
@Composable
fun EmptyState(title: String, body: String, glyph: GlyphKind, modifier: Modifier = Modifier,
    action: (@Composable () -> Unit)? = null) {
    Column(modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.padding(horizontal = 24.dp, vertical = 32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        GlyphTile(glyph, size = 64.dp)
        Text(title, style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        action?.invoke()
    }
}

/** Screen heading inside the white sheet: one title, one muted line under it. */
@Composable
fun PageIntro(title: String, subtitle: String? = null, modifier: Modifier = Modifier, titleTag: String? = null) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(title, style = MaterialTheme.typography.headlineSmall,
            modifier = if (titleTag != null) Modifier.testTag(titleTag) else Modifier)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/**
 * An inline notice: tinted fill, a glyph and one or two sentences. The word carries the meaning, the tint only supports it.
 * [textTag] goes on the text itself so tests and screen readers find the sentence.
 */
@Composable
fun NoticeCard(text: String, modifier: Modifier = Modifier, tone: Look.Tone = Look.Tone.NEUTRAL, glyph: GlyphKind = GlyphKind.INFO,
    textTag: String? = null) {
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(Look.fill(tone)).padding(horizontal = 14.dp, vertical = 12.dp),
        verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Glyph(glyph, Look.text(tone), 20.dp, Modifier.padding(top = 1.dp))
        Text(text, color = Look.text(tone), style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.weight(1f).then(if (textTag != null) Modifier.testTag(textTag) else Modifier))
    }
}

/** A text field in the shared look: 16 dp corners, accent border while focused, label above the entered text. */
@Composable
fun FieldTextField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    label: (@Composable () -> Unit)? = null, placeholder: (@Composable () -> Unit)? = null, singleLine: Boolean = false,
    minLines: Int = 1, isError: Boolean = false,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default) {
    OutlinedTextField(value, onValueChange, modifier = modifier.heightIn(min = 52.dp), enabled = enabled, label = label,
        placeholder = placeholder, singleLine = singleLine, minLines = if (singleLine) 1 else minLines, isError = isError,
        keyboardOptions = keyboardOptions, shape = RoundedCornerShape(16.dp), textStyle = MaterialTheme.typography.bodyLarge,
        colors = fieldColors())
}

/**
 * Same call shape as the Material OutlinedButton: an outlined pill, 48 dp tall, dark text. [primary] turns it into the one
 * filled red pill of a form (save). Extra named arguments go before the trailing content lambda.
 */
@Composable
fun FieldButton(onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, primary: Boolean = false,
    content: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    if (primary) {
        Button(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 52.dp), shape = RoundedCornerShape(Look.pill),
            colors = ButtonDefaults.buttonColors(disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant), content = content)
        return
    }
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.heightIn(min = 48.dp), shape = RoundedCornerShape(Look.pill),
        border = BorderStroke(1.5.dp, if (enabled) MaterialTheme.colorScheme.outline else Look.hairline),
        contentPadding = PaddingValues(horizontal = 18.dp, vertical = 8.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f)),
        content = content)
}

/**
 * A full-width choice: one line of text on a card, tinted and ticked while [selected]. The text stays a single node so it is
 * found, read and clicked as one sentence.
 */
@Composable
fun ChoiceRow(text: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Surface(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().heightIn(min = 56.dp), shape = RoundedCornerShape(Look.cardRadius),
        color = if (selected) Look.tint else Look.card,
        border = BorderStroke(if (selected) 1.5.dp else 1.dp, if (selected) Look.accent else Look.hairline)) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall.copy(fontWeight = if (selected) FontWeight.Bold else FontWeight.SemiBold),
                color = if (selected) Look.onTint else Look.ink, maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (selected) Glyph(GlyphKind.CHECK, Look.onTint, 20.dp) else Glyph(GlyphKind.CHEVRON, Look.muted, 18.dp)
        }
    }
}

/** A small number box for a quantity: centred digits, accent focus, error tint. */
@Composable
fun QuantityField(value: String, onValueChange: (String) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true,
    isError: Boolean = false, placeholder: String? = null) {
    OutlinedTextField(value, onValueChange, singleLine = true, enabled = enabled, isError = isError,
        modifier = modifier.heightIn(min = 52.dp),
        placeholder = placeholder?.let { { Text(it, Modifier.fillMaxWidth(), style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center) } },
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Number),
        shape = RoundedCornerShape(14.dp), textStyle = MaterialTheme.typography.titleSmall.copy(textAlign = TextAlign.Center),
        colors = fieldColors())
}

/** The bar that holds a screen's actions: full width, a soft shadow above it, content scrolls clear underneath. */
@Composable
fun ActionBar(modifier: Modifier = Modifier, content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit) {
    Surface(modifier.fillMaxWidth(), color = MaterialTheme.colorScheme.background, shadowElevation = 8.dp) {
        Column(Modifier.bottomSafe().padding(horizontal = 16.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp), content = content)
    }
}

/** SP-0163: keep bottom-pinned actions above the system navigation bar (3-button or gesture) and the keyboard.
 * Applies only what an ancestor (the app Scaffold's consumeWindowInsets, imePadding) has not consumed yet, so it never
 * double-pads inside the app shell and still protects screens hosted edge-to-edge without it. */
fun Modifier.bottomSafe(): Modifier = this.composed { windowInsetsPadding(
    androidx.compose.foundation.layout.WindowInsets.safeDrawing.only(
        androidx.compose.foundation.layout.WindowInsetsSides.Bottom + androidx.compose.foundation.layout.WindowInsetsSides.Horizontal)) }

/** A pill-shaped dropdown field: label above, the chosen value inside with a chevron. Tag goes on the tappable pill. */
@Composable
fun PickerField(label: String, valueText: String?, placeholder: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(start = 14.dp))
        Surface(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().heightIn(min = 52.dp),
            shape = RoundedCornerShape(Look.pill), color = MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.55f))) {
            Row(Modifier.padding(horizontal = 18.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(valueText ?: placeholder, style = MaterialTheme.typography.bodyLarge,
                    color = if (valueText != null) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Glyph(GlyphKind.CHEVRON, MaterialTheme.colorScheme.onSurfaceVariant, 18.dp, Modifier.rotate(90f))
            }
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
            .padding(16.dp).heightIn(min = 56.dp).testTag(tag),
        shape = RoundedCornerShape(28.dp),
        containerColor = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary,
        text = { Text(label, style = MaterialTheme.typography.titleSmall, maxLines = 1) },
        icon = { Text("+", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold) })
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

/** A text button at the header's top-right, e.g. "Edit" on a detail screen (docs/ui-actions.md). */
data class HeaderAction(val label: String, val onClick: () -> Unit, val tag: String = "header-action")

/** White text button for the red header (48 dp target). */
@Composable
internal fun HeaderTextButton(action: HeaderAction) {
    TextButton(onClick = action.onClick,
        modifier = Modifier.heightIn(min = 48.dp).testTag(action.tag)) {
        Text(action.label, color = Color.White, style = MaterialTheme.typography.titleSmall)
    }
}
