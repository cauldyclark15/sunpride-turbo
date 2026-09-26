package com.sunpride.field.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
fun AccountGlyph() {
    val color = MaterialTheme.colorScheme.onSurface
    Canvas(Modifier.size(22.dp).semantics { contentDescription = "Account" }) {
        val unit = size.width / 22f
        drawCircle(color, radius = 3.7f * unit, center = Offset(11f * unit, 6f * unit))
        drawArc(color, startAngle = 190f, sweepAngle = 160f, useCenter = false,
            topLeft = Offset(2f * unit, 11f * unit), size = Size(18f * unit, 18f * unit),
            style = Stroke(width = 2.2f * unit, cap = StrokeCap.Round))
    }
}

@Composable
fun SectionCard(label: String, modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    Surface(modifier = modifier.fillMaxWidth(), shape = SunprideTokens.shapes.large,
        color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.28f))) {
        Column {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.22f))
            content()
        }
    }
}

// No Compose material-icons artifact is on this module's compile classpath. Use Android's
// platform drawables rather than adding a dependency or using tiny Unicode placeholders.
@Composable
fun IconTile(initial: String) {
    Surface(shape = SunprideTokens.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f), tonalElevation = 0.dp) {
        Box(Modifier.size(36.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) {
            Text(initial, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun ListRow(title: String, meta: String, glyph: String, modifier: Modifier = Modifier,
    trailing: String? = null, onClick: (() -> Unit)? = null) {
    Surface(onClick = onClick ?: {}, enabled = onClick != null, color = MaterialTheme.colorScheme.surface,
        tonalElevation = 0.dp, modifier = modifier.fillMaxWidth().semantics(mergeDescendants = true) {}) {
        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            if (glyph == "store") IconTile(title.trim().take(1).uppercase())
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (meta.isNotEmpty()) Text(meta, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (onClick != null || glyph == "store") Text("›", style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
fun ValueRow(label: String, value: String, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().heightIn(min = 48.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = MaterialTheme.typography.bodyMedium)
        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.22f))
}

@Composable
fun LabeledField(label: String, value: String, onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier, enabled: Boolean = true,
    visualTransformation: androidx.compose.ui.text.input.VisualTransformation = androidx.compose.ui.text.input.VisualTransformation.None,
    keyboardOptions: androidx.compose.foundation.text.KeyboardOptions = androidx.compose.foundation.text.KeyboardOptions.Default) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Medium)
        OutlinedTextField(value, onValueChange, singleLine = true, enabled = enabled,
            visualTransformation = visualTransformation, keyboardOptions = keyboardOptions,
            modifier = modifier.fillMaxWidth().height(48.dp), shape = SunprideTokens.shapes.small,
            textStyle = MaterialTheme.typography.bodyMedium,
            colors = OutlinedTextFieldDefaults.colors(
                focusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.28f),
                disabledBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)))
    }
}

@Composable
fun StatusPill(label: String, modifier: Modifier = Modifier, warning: Boolean = false,
    onClick: (() -> Unit)? = null) {
    Surface(onClick = onClick ?: {}, enabled = onClick != null,
        modifier = modifier.semantics(mergeDescendants = true) {}, shape = CircleShape,
        color = if (warning) MaterialTheme.colorScheme.error.copy(alpha = 0.10f)
            else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f), tonalElevation = 0.dp) {
        Row(Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Surface(shape = CircleShape, color = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.size(6.dp)) {}
            Text(label, style = MaterialTheme.typography.labelMedium,
                color = if (warning) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
fun SecondaryButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier,
    enabled: Boolean = true, danger: Boolean = false) {
    OutlinedButton(onClick = onClick, enabled = enabled, modifier = modifier.height(48.dp),
        shape = SunprideTokens.shapes.small,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)),
        colors = ButtonDefaults.outlinedButtonColors(
            containerColor = MaterialTheme.colorScheme.surface,
            contentColor = if (danger) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
            disabledContainerColor = MaterialTheme.colorScheme.surface,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.78f))) {
        Text(label, fontWeight = FontWeight.Medium)
    }
}

@Composable
fun PrimaryBottomButton(label: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(onClick = onClick, enabled = enabled, modifier = modifier.fillMaxWidth().height(48.dp),
        shape = SunprideTokens.shapes.small,
        colors = ButtonDefaults.buttonColors(disabledContainerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.42f),
            disabledContentColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.82f))) {
        Text(label, fontWeight = FontWeight.Medium)
    }
}
