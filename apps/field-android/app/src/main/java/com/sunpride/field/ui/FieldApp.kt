package com.sunpride.field.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.tooling.preview.Preview
import com.sunpride.field.AppEnvironment

@Composable
fun FieldApp(environment: AppEnvironment, dark: Boolean, debug: Boolean) {
    MaterialTheme(
        colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        shapes = SunprideTokens.shapes,
        typography = SunprideTokens.typography
    ) {
        var preview by remember { mutableStateOf(false) }
        Scaffold(topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp,
                modifier = Modifier.statusBarsPadding()) {
                Column(Modifier.fillMaxWidth().padding(SunprideTokens.spacing4),
                    verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing2)) {
                    Text("Sunpride Field", style = MaterialTheme.typography.titleLarge)
                    SyncStatusPill()
                }
            }
        }) { padding ->
            if (preview && debug) TokenPreview(onBack = { preview = false }, Modifier.padding(padding))
            else SignInShell(environment, dark, debug, onPreview = { preview = true }, Modifier.padding(padding))
        }
    }
}

@Composable
private fun SyncStatusPill() {
    Surface(
        shape = SunprideTokens.shapes.small,
        color = MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.testTag("sync-status")
    ) {
        Text("Offline — not signed in", color = MaterialTheme.colorScheme.onSurfaceVariant,
            style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.padding(horizontal = SunprideTokens.spacing2, vertical = SunprideTokens.spacing1))
    }
}

@Composable
private fun SignInShell(environment: AppEnvironment, dark: Boolean, debug: Boolean, onPreview: () -> Unit, modifier: Modifier = Modifier) {
    var email by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SunprideTokens.spacing6),
        verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing4)) {
        Spacer(Modifier.height(SunprideTokens.spacing4))
        Text("Ready for the field", style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("shell-title"))
        Text("Sign in to see your assigned work when this app connects to Sunpride.",
            color = MaterialTheme.colorScheme.onBackground, style = MaterialTheme.typography.bodyLarge)
        if (!environment.isReady) {
            Surface(color = MaterialTheme.colorScheme.surface, shape = SunprideTokens.shapes.medium,
                modifier = Modifier.fillMaxWidth().testTag("environment-error")) {
                Column(Modifier.padding(SunprideTokens.spacing4)) {
                    Text("Configuration required", color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.titleLarge)
                    environment.errors.forEach { Text(it, color = MaterialTheme.colorScheme.onSurface) }
                }
            }
        }
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("email"), shape = SunprideTokens.shapes.medium)
        OutlinedTextField(password, { password = it }, label = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(), singleLine = true,
            modifier = Modifier.fillMaxWidth().testTag("password"), shape = SunprideTokens.shapes.medium)
        val tokens = SunprideTokens
        Button(onClick = {}, enabled = false,
            colors = ButtonDefaults.buttonColors(
                disabledContainerColor = if (dark) tokens.disabledDark else tokens.disabledLight,
                disabledContentColor = if (dark) tokens.snow else tokens.muted
            ),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("sign-in")) {
            Text("Sign in")
        }
        Text("Sign-in arrives in the next build", style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("sign-in-note"))
        if (debug) TextButton(onClick = onPreview, modifier = Modifier.testTag("design-tokens-link")) {
            Text("Design tokens")
        }
    }
}

@Composable
private fun TokenPreview(onBack: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SunprideTokens.spacing6),
        verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing3)) {
        TextButton(onClick = onBack) { Text("Back to sign in") }
        Text("Design tokens", style = MaterialTheme.typography.headlineMedium,
            modifier = Modifier.testTag("design-tokens-screen"))
        Surface(color = MaterialTheme.colorScheme.surface, shape = SunprideTokens.shapes.medium) {
            Row(Modifier.fillMaxWidth()) {
                Box(Modifier.size(48.dp).background(SunprideTokens.red))
                Text("Brand red", color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(SunprideTokens.spacing4))
            }
        }
        listOf(
            Triple("Yellow / caution", SunprideTokens.yellow, SunprideTokens.ink),
            Triple("Success", SunprideTokens.success, SunprideTokens.ink),
            Triple("Danger", SunprideTokens.danger, SunprideTokens.snow),
            Triple("Surface", MaterialTheme.colorScheme.surface, MaterialTheme.colorScheme.onSurface)
        ).forEach { (label, background, foreground) ->
            Surface(color = background, shape = SunprideTokens.shapes.medium, modifier = Modifier.fillMaxWidth()) {
                Text(label, color = foreground, style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(SunprideTokens.spacing4))
            }
        }
        Text("4 dp spacing · 8/12 dp radii · system font", style = MaterialTheme.typography.bodyMedium)
    }
}

private val previewEnvironment = AppEnvironment("https://preview.convex.site", "https://preview.convex.cloud")
@Preview(name = "Light", showBackground = true)
@Composable private fun LightPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
@Preview(name = "Dark", showBackground = true, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable private fun DarkPreview() = FieldApp(previewEnvironment, dark = true, debug = true)
@Preview(name = "Large font", showBackground = true, fontScale = 2f)
@Composable private fun LargeFontPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
