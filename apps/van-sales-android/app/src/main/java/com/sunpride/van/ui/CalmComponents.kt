package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.dp

/** Field-app palette, cards and shapes; handheld buttons/fields enlarged to 56dp. */
@Composable fun PrimaryBottomButton(label: String, onClick: () -> Unit, enabled: Boolean = true, tag: String = "primary") {
    Button(onClick, enabled = enabled, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag),
        shape = SunprideTokens.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.secondary,
            contentColor = MaterialTheme.colorScheme.onSecondary,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
        Text(label, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    }
}
@Composable fun SecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    OutlinedButton(onClick, modifier.fillMaxWidth().heightIn(min = 56.dp), enabled = enabled,
        shape = SunprideTokens.shapes.small, colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .28f))) { Text(label, style = MaterialTheme.typography.titleMedium) }
}
@Composable fun SectionCard(label: String, content: @Composable ColumnScope.() -> Unit) {
    Surface(Modifier.fillMaxWidth(), shape = SunprideTokens.shapes.large,
        color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = .28f))) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            content()
        }
    }
}
@Composable fun ListRow(title: String, meta: String = "", tag: String = "", enabled: Boolean = true, onClick: (() -> Unit)? = null) {
    Surface(Modifier.fillMaxWidth().testTag(tag), color = MaterialTheme.colorScheme.surface,
        shape = SunprideTokens.shapes.small) {
        Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).then(if (onClick != null) Modifier.clickable(enabled = enabled,onClick = onClick) else Modifier)
            .padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                if (meta.isNotBlank()) Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (onClick != null && enabled) Text("›", style = MaterialTheme.typography.titleLarge)
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
    revealed: Boolean = false, onToggleReveal: (() -> Unit)? = null) {
    OutlinedTextField(value, { if (it.length <= maxLength) onChange(it) }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag),
        label = { Text(label) }, singleLine = true, enabled = enabled,
        visualTransformation = if (password && !revealed) PasswordVisualTransformation() else VisualTransformation.None,
        trailingIcon = if (password && onToggleReveal != null) ({
            val description = passwordToggleLabel(revealed)
            IconButton(onToggleReveal, Modifier.size(56.dp).testTag("$tag-toggle").semantics { contentDescription = description }) {
                EyeGlyph(crossed = revealed)
            }
        }) else null,
        keyboardOptions = KeyboardOptions(keyboardType = when { password -> KeyboardType.Password; numeric -> KeyboardType.Decimal; tag == "email" -> KeyboardType.Email; else -> KeyboardType.Text }),
        shape = SunprideTokens.shapes.small, textStyle = MaterialTheme.typography.bodyLarge,
        colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = MaterialTheme.colorScheme.onSurface,
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
    content: @Composable ColumnScope.() -> Unit) {
    Scaffold(Modifier.fillMaxSize().imePadding(), containerColor = MaterialTheme.colorScheme.background,
        contentWindowInsets = WindowInsets.systemBars,
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface) {
                Row(Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 64.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (onBack != null) TextButton(onBack,Modifier.heightIn(min = 56.dp).testTag("back"), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Back") }
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).testTag("screen-title"))
                }
            }
        }, bottomBar = {
            if (action != null || footer != null || bottomContent != null) Surface(color = MaterialTheme.colorScheme.surface) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
