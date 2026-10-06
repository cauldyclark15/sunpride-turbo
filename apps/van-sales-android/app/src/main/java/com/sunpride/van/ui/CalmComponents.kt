package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
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
@Composable fun LabeledField(label: String, value: String, onChange: (String) -> Unit, tag: String,
    numeric: Boolean = false, password: Boolean = false, enabled: Boolean = true, maxLength: Int = 300) {
    OutlinedTextField(value, { if (it.length <= maxLength) onChange(it) }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag(tag),
        label = { Text(label) }, singleLine = true, enabled = enabled,
        visualTransformation = if (password) PasswordVisualTransformation() else VisualTransformation.None,
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
    message: String? = null, scroll: Boolean = true, content: @Composable ColumnScope.() -> Unit) {
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
            if (action != null || footer != null) Surface(color = MaterialTheme.colorScheme.surface) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp),verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
