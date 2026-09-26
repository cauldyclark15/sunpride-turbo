package com.sunpride.field.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import kotlinx.coroutines.delay

/** Pill style for each state; the text carries the meaning, colour only reinforces it. */
enum class StatusPill(val label: String, val marker: String) {
    OFFLINE("Offline — not signed in", "!"),
    UNREGISTERED("Signed in — phone not registered", "!"),
    READY("Ready", "✓"),
    REMOVED("Phone removed", "✕");

    val background: Color get() = when (this) {
        OFFLINE, UNREGISTERED -> SunprideTokens.yellow
        READY -> SunprideTokens.success
        REMOVED -> SunprideTokens.danger
    }
    val foreground: Color get() = if (this == REMOVED) SunprideTokens.snow else SunprideTokens.ink

    companion object {
        fun of(state: EnrollmentState) = when (state) {
            EnrollmentState.SignedOut -> OFFLINE
            EnrollmentState.Unregistered -> UNREGISTERED
            is EnrollmentState.Ready -> READY
            EnrollmentState.Removed -> REMOVED
        }
    }
}

@Composable
fun FieldApp(
    environment: AppEnvironment,
    dark: Boolean,
    debug: Boolean,
    backend: FieldBackend? = null,
    onKeyLoaded: (DeviceKeyInfo) -> Unit = {},
    visitLocation: com.sunpride.field.ui.diagnosticvisit.VisitLocation? = null
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val location = remember(visitLocation) { visitLocation ?: com.sunpride.field.ui.diagnosticvisit.AndroidVisitLocation(context) }
    val offline = com.sunpride.field.ui.syncstatus.rememberOffline()
    val controller = remember(backend) {
        FieldController(backend ?: UnconfiguredBackend, scope, onKeyLoaded = onKeyLoaded)
    }
    var preview by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(controller) { controller.start(configured = environment.isReady) }
    // Auto-poll `mine` every 10 s while signed in and waiting for an admin to register the phone.
    LaunchedEffect(controller, controller.state) {
        while (controller.state == EnrollmentState.Unregistered) {
            delay(com.sunpride.field.auth.Enrollment.POLL_INTERVAL_MS)
            // The state-keyed effect is cancelled as soon as enrollment becomes Ready.
            // Start verification in the controller's longer-lived scope so its first bootstrap
            // is not cancelled between setting Ready and loading Today.
            controller.checkAgain(quiet = true)
        }
    }
    MaterialTheme(
        colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        shapes = SunprideTokens.shapes, typography = SunprideTokens.typography
    ) {
        Scaffold(topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp,
                modifier = Modifier.statusBarsPadding()) {
                Column(Modifier.fillMaxWidth().padding(SunprideTokens.spacing4),
                    verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing2)) {
                    Text("Sunpride Field", style = MaterialTheme.typography.titleLarge,
                        color = MaterialTheme.colorScheme.onSurface)
                    SyncStatusPill(StatusPill.of(controller.state))
                    if (controller.state is EnrollmentState.Ready) Text(
                        controller.today.syncStatus.copy(offline = offline).label(System.currentTimeMillis()).let {
                            if (controller.today.stale && it == "All synced") "Saved data · verification pending" else it
                        },
                        modifier = Modifier.testTag("sync-state"), style = MaterialTheme.typography.labelLarge)
                }
            }
        }) { padding ->
            val modifier = Modifier.padding(padding)
            when {
                preview && debug -> TokenPreview(onBack = { preview = false }, modifier)
                controller.state == EnrollmentState.SignedOut -> SignInScreen(
                    environment, dark, debug, controller.busy, controller.error,
                    onPreview = { preview = true }, onSignIn = controller::signIn, modifier = modifier)
                controller.diagnostic != null && debug -> com.sunpride.field.ui.diagnosticvisit.DiagnosticVisitScreen(
                    controller.diagnostic!!, controller, location, controller::closeDiagnostic, modifier)
                controller.state is EnrollmentState.Ready -> TodayScreen(controller.today, controller.busy,
                    onSync = controller::syncNow, onSignOut = controller::signOut,
                    onVisit = controller::openDiagnostic, diagnosticEnabled = debug, modifier = modifier,
                    offline = offline)
                else -> EnrollmentScreen(controller.state, controller.key, controller.busy, controller.error,
                    onCheck = { controller.checkAgain() }, onSignOut = { controller.signOut() }, modifier = modifier)
            }
        }
    }
}

/** Used only when no backend is wired (previews); every call fails closed. */
private object UnconfiguredBackend : FieldBackend {
    override val isSignedIn = false
    override fun loadSigner(): DeviceSigner = error("No device key in preview")
    override fun signIn(email: String, password: String) =
        throw com.sunpride.field.auth.AuthFailure(com.sunpride.field.auth.AuthFailure.Kind.NOT_CONFIGURED)
    override fun signOut() = Unit
    override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.SignedOut
}

@Composable
fun SyncStatusPill(pill: StatusPill) {
    Surface(shape = SunprideTokens.shapes.small, color = pill.background,
        modifier = Modifier.testTag("sync-status").semantics(mergeDescendants = true) {}) {
        Text("${pill.marker}  ${pill.label}", color = pill.foreground, style = MaterialTheme.typography.labelLarge,
            modifier = Modifier.padding(horizontal = SunprideTokens.spacing3, vertical = SunprideTokens.spacing1))
    }
}

@Composable
private fun SignInScreen(
    environment: AppEnvironment, dark: Boolean, debug: Boolean, busy: Boolean, error: String?,
    onPreview: () -> Unit, onSignIn: (String, String) -> Unit, modifier: Modifier = Modifier
) {
    var email by rememberSaveable { mutableStateOf("") }
    // Deliberately not rememberSaveable: the password must not enter the saved-instance-state bundle.
    var password by remember { mutableStateOf("") }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SunprideTokens.spacing6),
        verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing4)) {
        Spacer(Modifier.height(SunprideTokens.spacing4))
        Text("Ready for the field", style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("shell-title"))
        Text("Sign in with the account your administrator invited.",
            color = MaterialTheme.colorScheme.onBackground, style = MaterialTheme.typography.bodyLarge,
            modifier = Modifier.testTag("sign-in-note"))
        if (!environment.isReady) Surface(color = MaterialTheme.colorScheme.surface, shape = SunprideTokens.shapes.medium,
            modifier = Modifier.fillMaxWidth().testTag("environment-error")) {
            Column(Modifier.padding(SunprideTokens.spacing4)) {
                Text("Configuration required", color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.titleLarge)
                environment.errors.forEach { Text(it, color = MaterialTheme.colorScheme.onSurface) }
            }
        }
        OutlinedTextField(email, { email = it }, label = { Text("Email") }, singleLine = true, enabled = !busy,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            modifier = Modifier.fillMaxWidth().testTag("email"), shape = SunprideTokens.shapes.medium)
        OutlinedTextField(password, { password = it }, label = { Text("Password") }, enabled = !busy,
            visualTransformation = PasswordVisualTransformation(), singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            modifier = Modifier.fillMaxWidth().testTag("password"), shape = SunprideTokens.shapes.medium)
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("auth-error"))
        Button(onClick = { val secret = password; password = ""; onSignIn(email.trim(), secret) },
            enabled = environment.isReady && !busy && email.isNotBlank() && password.isNotEmpty(),
            colors = ButtonDefaults.buttonColors(
                disabledContainerColor = if (dark) SunprideTokens.disabledDark else SunprideTokens.disabledLight,
                disabledContentColor = if (dark) SunprideTokens.snow else SunprideTokens.muted),
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("sign-in")) {
            if (busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Text("Sign in")
        }
        if (debug) TextButton(onClick = onPreview, modifier = Modifier.testTag("design-tokens-link")) { Text("Design tokens") }
    }
}

@Composable
fun TodayScreen(data: TodayData, busy: Boolean, onSync: () -> Unit, onSignOut: () -> Unit,
                modifier: Modifier = Modifier, onVisit: (VisitDisplay) -> Unit = {}, diagnosticEnabled: Boolean = false,
                offline: Boolean = false) {
    val status = data.syncStatus.copy(offline = offline)
    var details by remember { mutableStateOf(false) }
    var support by remember { mutableStateOf(false) }
    if (details) com.sunpride.field.ui.syncstatus.SyncDetails(status) { details = false }
    if (support) com.sunpride.field.ui.syncstatus.SupportDetails(status) { support = false }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SunprideTokens.spacing6),
        verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing4)) {
        Text("Phone ready", style = MaterialTheme.typography.titleMedium)
        Text("Today", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("today-title"))
        Text(status.label(System.currentTimeMillis()).let {
            when { data.stale && it == "All synced" -> "Stale · verification pending"
                data.stale && !status.pending -> "Stale · $it"
                it == "Sync pending" -> "Stale · offline/pending"; else -> it }
        },
            color = if (data.stale || status.pending) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag("today-stale"))
        Text("Last synced: " + com.sunpride.field.ui.syncstatus.manilaTime(status.lastSuccess ?: data.lastSynced),
            modifier = Modifier.testTag("last-synced"))
        TextButton(onClick = { details = true }, modifier = Modifier.testTag("sync-details")) { Text("Sync details · review") }
        TextButton(onClick = { support = true }, modifier = Modifier.testTag("support-info")) { Text("Support info") }
        data.warning?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("today-warning")) }
        if (data.queuedCount > 0) Text("Queued: ${data.queuedCount}", modifier = Modifier.testTag("queued-count"))
        if (data.reviewCount > 0) Text("Needs review: ${data.reviewCount}", modifier = Modifier.testTag("review-count"))
        Button(onClick = onSync, enabled = !busy && !data.updateRequired, modifier = Modifier.fillMaxWidth().testTag("sync-now")) {
            Text(if (busy) "Syncing…" else "Sync now")
        }
        if (data.visits.isEmpty()) Text("No visits saved for today", modifier = Modifier.testTag("today-empty"))
        data.visits.forEach { visit ->
            Surface(shape = SunprideTokens.shapes.medium, color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth().testTag("today-visit").semantics(mergeDescendants = true) {}) {
                Column(Modifier.padding(SunprideTokens.spacing4)) {
                    Text(visit.outlet, style = MaterialTheme.typography.titleMedium)
                    Text("${visit.planned} · ${if (busy && visit.status == "Queued") "Sending" else visit.status}")
                    if (diagnosticEnabled) TextButton(onClick = { onVisit(visit) },
                        modifier = Modifier.testTag("diagnostic-open")) { Text("DEV visit") }
                }
            }
        }
        if (diagnosticEnabled && data.unplannedOutlets.isNotEmpty()) {
            Text("Unplanned DEV visit (requires reason)")
            data.unplannedOutlets.forEach { outlet -> TextButton(onClick = { onVisit(outlet) }) {
                Text(outlet.outlet)
            } }
        }
        TextButton(onClick = onSignOut, enabled = !busy, modifier = Modifier.testTag("sign-out")) { Text("Sign out") }
    }
}

@Composable
fun EnrollmentScreen(
    state: EnrollmentState, key: DeviceKeyInfo?, busy: Boolean, error: String?,
    onCheck: () -> Unit, onSignOut: () -> Unit, modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SunprideTokens.spacing6),
        verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing4)) {
        Text(when (state) {
            EnrollmentState.Removed -> "This phone was removed — ask your admin"
            is EnrollmentState.Ready -> "Phone ready"
            else -> "This phone isn't registered yet"
        }, style = MaterialTheme.typography.headlineMedium, color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.testTag("enrollment-title"))
        if (state == EnrollmentState.Unregistered) {
            Text("Send this key to your administrator. Registration is done by an admin; this screen checks every 10 seconds.",
                color = MaterialTheme.colorScheme.onBackground)
            if (key != null) Surface(color = MaterialTheme.colorScheme.surface, shape = SunprideTokens.shapes.medium,
                modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(SunprideTokens.spacing4), verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing2)) {
                    Text("Device public key", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
                    SelectionContainer {
                        Text(key.publicKey, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag("public-key"))
                    }
                    Text("Fingerprint ${key.fingerprint}", fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag("key-fingerprint"))
                    OutlinedButton(onClick = {
                        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                            .setPrimaryClip(ClipData.newPlainText("Sunpride device public key", key.publicKey))
                    }, modifier = Modifier.testTag("copy-key")) { Text("Copy key") }
                }
            } else if (busy) CircularProgressIndicator(Modifier.testTag("key-loading"))
            Text("${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} · app ${BuildConfig.VERSION_NAME}" +
                (key?.let { " · key ${it.protection}" } ?: ""),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onBackground,
                modifier = Modifier.testTag("device-info"))
            Button(onClick = onCheck, enabled = !busy, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("check-again")) {
                Text(if (busy) "Checking…" else "Check again")
            }
        }
        if (state is EnrollmentState.Ready) Text("This phone is bound to your account.",
            color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("ready-note"))
        if (state == EnrollmentState.Removed) Text("It can no longer sync. Your administrator can register a replacement.",
            color = MaterialTheme.colorScheme.onBackground)
        if (error != null) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("auth-error"))
        TextButton(onClick = onSignOut, enabled = !busy, modifier = Modifier.testTag("sign-out")) { Text("Sign out") }
    }
}

@Composable
private fun TokenPreview(onBack: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(SunprideTokens.spacing6),
        verticalArrangement = Arrangement.spacedBy(SunprideTokens.spacing3)) {
        TextButton(onClick = onBack) { Text("Back to sign in") }
        Text("Design tokens", style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground, modifier = Modifier.testTag("design-tokens-screen"))
        Surface(color = MaterialTheme.colorScheme.surface, shape = SunprideTokens.shapes.medium) {
            Row(Modifier.fillMaxWidth()) {
                Box(Modifier.size(48.dp).background(SunprideTokens.red))
                Text("Brand red", color = MaterialTheme.colorScheme.onSurface,
                    style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(SunprideTokens.spacing4))
            }
        }
        StatusPill.entries.forEach { SyncStatusPill(it) }
        Surface(color = MaterialTheme.colorScheme.surface, shape = SunprideTokens.shapes.medium, modifier = Modifier.fillMaxWidth()) {
            Text("Surface", color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(SunprideTokens.spacing4))
        }
        Text("4 dp spacing · 8/12 dp radii · system font", color = MaterialTheme.colorScheme.onBackground)
    }
}

private val previewEnvironment = AppEnvironment("https://preview.convex.site", "https://preview.convex.cloud")
@Preview(name = "Light", showBackground = true)
@Composable private fun LightPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
@Preview(name = "Dark", showBackground = true, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable private fun DarkPreview() = FieldApp(previewEnvironment, dark = true, debug = true)
@Preview(name = "Large font", showBackground = true, fontScale = 2f)
@Composable private fun LargeFontPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
