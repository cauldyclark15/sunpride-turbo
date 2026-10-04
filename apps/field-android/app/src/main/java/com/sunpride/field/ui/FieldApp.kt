package com.sunpride.field.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import androidx.core.net.toUri
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.ui.syncstatus.SyncDetails
import com.sunpride.field.ui.syncstatus.SupportDetails
import kotlinx.coroutines.delay

// Legacy pure mapping retained for compatibility tests; non-ready states never render a pill.
enum class StatusPill(val label: String) {
    OFFLINE("Offline"), UNREGISTERED("Waiting for admin"), READY("Synced"), REMOVED("Phone removed");
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
    environment: AppEnvironment, dark: Boolean, debug: Boolean, backend: FieldBackend? = null,
    onKeyLoaded: (DeviceKeyInfo) -> Unit = {},
    visitLocation: com.sunpride.field.ui.diagnosticvisit.VisitLocation? = null
) {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val location = remember(visitLocation) { visitLocation ?: com.sunpride.field.ui.diagnosticvisit.AndroidVisitLocation(context) }
    val offline = com.sunpride.field.ui.syncstatus.rememberOffline()
    val controller = remember(backend) { FieldController(backend ?: UnconfiguredBackend, scope, onKeyLoaded = onKeyLoaded) }
    var page by rememberSaveable { mutableStateOf("home") }
    var customerId by rememberSaveable { mutableStateOf<String?>(null) }
    val customer = customerId?.let { id -> controller.today.customers.firstOrNull { it.outletId == id } }
    LaunchedEffect(controller) { controller.start(configured = environment.isReady) }
    // AND-020: each visit to the Team page asks the server again (saved copy when offline).
    LaunchedEffect(controller, page, controller.state) {
        if (page == "team" && controller.state is EnrollmentState.Ready) controller.loadTeam()
    }
    LaunchedEffect(controller, controller.state) {
        while (controller.state == EnrollmentState.Unregistered) {
            delay(com.sunpride.field.auth.Enrollment.POLL_INTERVAL_MS)
            controller.checkAgain(quiet = true)
        }
    }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { delay(1_000); now = System.currentTimeMillis() } }
    val ready = controller.state is EnrollmentState.Ready
    val status = controller.today.syncStatus.copy(offline = offline)
    MaterialTheme(colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        shapes = SunprideTokens.shapes, typography = SunprideTokens.typography) {
        Scaffold(containerColor = MaterialTheme.colorScheme.background, topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 0.dp, modifier = Modifier.statusBarsPadding()) {
                Column {
                Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 20.dp),
                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    if (controller.diagnostic != null && ready && (page == "home" || page == "route" || page == "customers" || page == "customer")) Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = {
                            when {
                                controller.photoCaptureOpen -> controller.closePhotoCapture()
                                controller.orderOpen -> controller.closeOrder()
                                controller.activityForm != null -> controller.closeActivityForm()
                                controller.callSheetOpen -> controller.closeCallSheet()
                                else -> controller.closeDiagnostic()
                            }
                        }, modifier = Modifier.height(48.dp).testTag("visit-back")) {
                            Text("‹", style = MaterialTheme.typography.titleLarge)
                        }
                        Text(if (controller.photoCaptureOpen) "Photo" else if (controller.orderOpen) "Order" else controller.activityForm?.let {
                            com.sunpride.field.storage.ActivityRules.kindLabel(it) }
                            ?: if (controller.callSheetOpen) "Call sheet" else "Visit", style = MaterialTheme.typography.titleMedium)
                    } else if (page == "account" || page == "sync" || page == "support" ||
                        (ready && (page == "route" || page == "customers" || page == "customer" || page == "team"))) Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = { page = when (page) { "support" -> "account"; "customer" -> "customers"; else -> "home" } },
                            modifier = Modifier.height(48.dp).testTag(when (page) {
                                "sync" -> "sync-back"; "support" -> "support-back"; "route" -> "route-back"
                                "customers" -> "customers-back"; "customer" -> "customer-back"; "team" -> "team-back"
                                else -> "account-back"
                            })) {
                            Text("‹", style = MaterialTheme.typography.titleLarge)
                        }
                        Text(when (page) {
                            "sync" -> "Sync"; "support" -> "Support info"; "route" -> "Route"
                            "customers" -> "Customers"; "customer" -> "Outlet"; "team" -> "Team"; else -> "Account"
                        }, style = MaterialTheme.typography.titleMedium,
                            modifier = when (page) {
                                "account" -> Modifier.testTag("account-title"); "route" -> Modifier.testTag("route-title")
                                "customers" -> Modifier.testTag("customers-title"); "customer" -> Modifier.testTag("customer-title")
                                "team" -> Modifier.testTag("team-title")
                                else -> Modifier
                            })
                    } else Text("Sunpride Field", style = MaterialTheme.typography.titleMedium)
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        if (controller.state != EnrollmentState.SignedOut) IconButton(onClick = { page = "account" },
                            modifier = Modifier.height(48.dp).testTag("account-open")) {
                            AccountGlyph()
                        }
                    }
                }
                if (ready) StatusPill(status.label(now), Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp)
                    .testTag("sync-status"), onClick = { page = "sync" })
                }
            }
        }) { padding ->
            val modifier = Modifier.padding(padding)
            when {
                controller.state == EnrollmentState.SignedOut -> SignInScreen(environment, controller.busy, controller.error,
                    controller::signIn, modifier)
                page == "account" -> AccountScreen(controller.key, controller::signOut,
                    onBack = { page = "home" }, onSupport = { page = "support" }, modifier = modifier)
                page == "support" -> SupportDetails(status, { page = "account" }, modifier)
                ready && page == "sync" -> SyncDetails(status, onDismiss = { page = "home" },
                    onSync = controller::syncNow, busy = controller.busy, modifier = modifier)
                controller.diagnostic != null && debug && ready && controller.photoCaptureOpen ->
                    com.sunpride.field.ui.diagnosticvisit.PhotoCaptureScreen(controller, modifier)
                controller.diagnostic != null && debug && ready && controller.activityForm != null ->
                    com.sunpride.field.ui.diagnosticvisit.ActivityFormScreen(controller.activityForm!!, controller, modifier)
                controller.diagnostic != null && debug && ready && controller.orderOpen && controller.diagnosticCallSheet != null ->
                    com.sunpride.field.ui.orders.OrderDraftScreen(controller.diagnostic!!, controller.diagnosticCallSheet!!,
                        controller, modifier)
                controller.diagnostic != null && debug && ready && controller.callSheetOpen && controller.diagnosticCallSheet != null ->
                    com.sunpride.field.ui.diagnosticvisit.CallSheetScreen(controller.diagnosticCallSheet!!, controller, modifier)
                controller.diagnostic != null && debug && ready -> com.sunpride.field.ui.diagnosticvisit.DiagnosticVisitScreen(
                    controller.diagnostic!!, controller, location, controller::closeDiagnostic, modifier)
                ready && page == "route" -> com.sunpride.field.ui.route.RouteScreen(controller.today, location,
                    onNavigate = { uri -> openMaps(context, uri) }, modifier = modifier,
                    onVisit = controller::openDiagnostic, visitEnabled = debug, offline = offline)
                ready && page == "customers" -> com.sunpride.field.ui.customers.CustomerSearchScreen(controller.today,
                    onOpen = { id -> customerId = id; page = "customer" }, modifier = modifier, offline = offline, now = now)
                ready && page == "customer" && customer != null -> com.sunpride.field.ui.customers.CustomerDetailScreen(
                    customer, controller.today, onNavigate = { uri -> openMaps(context, uri) },
                    onDial = { uri -> openDialer(context, uri) }, modifier = modifier,
                    onVisit = controller::openDiagnostic, visitEnabled = debug, now = now)
                ready && page == "customer" -> com.sunpride.field.ui.customers.CustomerSearchScreen(controller.today,
                    onOpen = { id -> customerId = id; page = "customer" }, modifier = modifier, offline = offline, now = now)
                ready && page == "team" -> com.sunpride.field.ui.team.TeamScreen(controller.team,
                    controller.teamDirectOnly, controller.teamLoading, now,
                    onFilter = { controller.loadTeam(it) }, onRefresh = { controller.loadTeam() }, modifier = modifier)
                ready -> TodayScreen(controller.today, controller.busy,
                    onSync = controller::syncNow, onSignOut = controller::signOut,
                    onVisit = controller::openDiagnostic, diagnosticEnabled = debug, modifier = modifier, offline = offline,
                    onRoute = { page = "route" }, onCustomers = { page = "customers" },
                    onTeam = { page = "team" })
                else -> EnrollmentScreen(controller.state, controller.key, controller.busy, controller.error,
                    onCheck = { controller.checkAgain() }, onSignOut = { controller.signOut() }, modifier = modifier,
                    unsent = status.queued + status.sending + status.review + status.held)
            }
        }
    }
}

/** Hands a `tel:` URI to the dialer (the user presses call; no CALL_PHONE permission). */
private fun openDialer(context: Context, uri: String): Boolean = try {
    context.startActivity(android.content.Intent(android.content.Intent.ACTION_DIAL, uri.toUri())
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: android.content.ActivityNotFoundException) { false }

/** Hands a `geo:` URI to the user's maps app, else web directions; false when nothing can open either. */
private fun openMaps(context: Context, uri: String): Boolean = com.sunpride.field.ui.route.MapLaunch.open(uri) { link ->
    try {
        context.startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, link.toUri())
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (_: android.content.ActivityNotFoundException) { false }
}

private object UnconfiguredBackend : FieldBackend {
    override val isSignedIn = false
    override fun loadSigner(): DeviceSigner = error("No device key in preview")
    override fun signIn(email: String, password: String) =
        throw com.sunpride.field.auth.AuthFailure(com.sunpride.field.auth.AuthFailure.Kind.NOT_CONFIGURED)
    override fun signOut() = Unit
    override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.SignedOut
}

@Composable
private fun SignInScreen(environment: AppEnvironment, busy: Boolean, error: String?,
    onSignIn: (String, String) -> Unit, modifier: Modifier = Modifier) {
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Sign in", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("shell-title"))
            if (!environment.isReady) SectionCard("Configuration required", Modifier.testTag("environment-error")) {
                environment.errors.forEach { Text(it, Modifier.padding(16.dp)) }
            }
            LabeledField("Email", email, { email = it }, Modifier.fillMaxWidth().testTag("email"), !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            LabeledField("Password", password, { password = it }, Modifier.fillMaxWidth().testTag("password"), !busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
            if (error != null) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("auth-error"))
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        PrimaryBottomButton(if (busy) "Signing in…" else "Sign in", {
            val secret = password; password = ""; onSignIn(email.trim(), secret)
        }, Modifier.testTag("sign-in"), environment.isReady && !busy && email.isNotBlank() && password.isNotEmpty())
    }
}

@Composable
fun TodayScreen(data: TodayData, busy: Boolean, onSync: () -> Unit, onSignOut: () -> Unit,
    modifier: Modifier = Modifier, onVisit: (VisitDisplay) -> Unit = {}, diagnosticEnabled: Boolean = false,
    offline: Boolean = false, onRoute: (() -> Unit)? = null, onCustomers: (() -> Unit)? = null,
    onTeam: (() -> Unit)? = null) {
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Today", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("today-title"))
        Text(java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).format(
            java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d", java.util.Locale.ENGLISH)),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (onRoute != null && data.visits.isNotEmpty()) SectionCard("Route") {
            val next = com.sunpride.field.ui.route.DailyRoutes.build(data.visits, null).next
            ListRow(next?.let { "Next: ${it.visit.outlet}" } ?: "All stops done",
                "${data.visits.size} stops · distance and directions", "route", Modifier.testTag("route-open"),
                onClick = onRoute)
        }
        if (onTeam != null && data.supervisor) SectionCard("Team") {
            ListRow("Your team today", "Coverage and exceptions for your direct reports", "team",
                Modifier.testTag("team-open"), onClick = onTeam)
        }
        if (onCustomers != null) SectionCard("Customers") {
            ListRow("Search customers", if (data.customers.isEmpty()) "Sync to download your outlets"
                else "${data.customers.size} outlets saved on this phone", "search",
                Modifier.testTag("customers-open"), onClick = onCustomers)
        }
        SectionCard("Visits · ${data.visits.size}") {
            if (data.visits.isEmpty()) Text("No visits today", Modifier.padding(16.dp).testTag("today-empty"))
            data.visits.withIndex().sortedBy { it.value.sequence ?: it.value.listPosition ?: it.index }.forEach { (_, visit) ->
                val facts = listOfNotNull(visit.planned.takeUnless { it == "Planned" || it == "Scheduled" || it.isBlank() },
                    visit.status.takeUnless { it == "Planned" || it == "Scheduled" || it == "Pending" || it.isBlank() }
                        ?.replace("Queued", "Waiting"), visit.timeSpent)
                if (diagnosticEnabled) androidx.compose.foundation.layout.Box(Modifier.testTag("today-visit")) {
                    ListRow(visit.outlet, facts.joinToString(" · "), "store", Modifier.testTag("diagnostic-open"),
                        onClick = { onVisit(visit) })
                } else ListRow(visit.outlet, facts.joinToString(" · "), "store", Modifier.testTag("today-visit"))
            }
        }
        if (diagnosticEnabled && data.unplannedOutlets.isNotEmpty()) SectionCard("Unplanned visit") {
            data.unplannedOutlets.forEach { outlet -> ListRow(outlet.outlet, "", "store",
                Modifier.testTag("unplanned-open"), onClick = { onVisit(outlet) }) }
        }
        data.warning?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("today-warning")) }
    }
}

@Composable
fun EnrollmentScreen(state: EnrollmentState, key: DeviceKeyInfo?, busy: Boolean, error: String?,
    onCheck: () -> Unit, onSignOut: () -> Unit, modifier: Modifier = Modifier, unsent: Int = 0) {
    val context = LocalContext.current
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(if (state == EnrollmentState.Removed) "Phone removed" else "Register phone",
                style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("enrollment-title"))
            if (state == EnrollmentState.Unregistered) {
                Text("Send this code to your admin", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (key != null) SectionCard("Phone code") {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(key.fingerprint.replace(":", "").chunked(4).joinToString(" "),
                            fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.testTag("key-fingerprint"))
                        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.testTag("show-full-code"),
                            colors = androidx.compose.material3.ButtonDefaults.textButtonColors(
                                contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
                            Text(if (expanded) "Hide full code" else "Show full code",
                                style = MaterialTheme.typography.bodyMedium)
                        }
                        if (expanded) SelectionContainer { Text(key.publicKey, fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("public-key")) }
                    }
                } else if (busy) CircularProgressIndicator(Modifier.testTag("key-loading"))
            }
            if (state == EnrollmentState.Removed) {
                Text("Ask your admin to re-add this phone", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (unsent > 0) Text("$unsent unsent on this phone", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (error != null) Text(error, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("auth-error"))
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        if (state == EnrollmentState.Unregistered) SecondaryButton("Check again", onCheck,
            Modifier.fillMaxWidth().testTag("check-again"), !busy)
        else SecondaryButton("Sign out", onSignOut, Modifier.fillMaxWidth().testTag("sign-out"), !busy, danger = true)
        androidx.compose.foundation.layout.Spacer(Modifier.height(8.dp))
        if (state == EnrollmentState.Unregistered) PrimaryBottomButton("Copy code", {
            key?.let { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                .setPrimaryClip(ClipData.newPlainText("Phone code", it.publicKey)) }
        }, Modifier.testTag("copy-key"), key != null)
        else PrimaryBottomButton(if (busy) "Checking…" else "Check again", onCheck,
            Modifier.testTag("check-again-primary"), !busy)
    }
}

@Composable
fun AccountScreen(key: DeviceKeyInfo?, onSignOut: () -> Unit, onBack: () -> Unit,
    onSupport: () -> Unit = {}, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            SectionCard("Phone") {
                ValueRow("Model", if (Build.MODEL.startsWith("sdk_")) "Android emulator" else Build.MODEL, Modifier.testTag("device-info"))
                ValueRow("OS", "Android ${Build.VERSION.RELEASE}")
                ValueRow("App version", BuildConfig.VERSION_NAME)
                ValueRow("Key storage", key?.protection ?: "Unavailable")
                ValueRow("Fingerprint", key?.fingerprint ?: "Unavailable")
            }
            SectionCard("Support") { ListRow("Support info", "", "info", Modifier.testTag("support-info"), onClick = onSupport) }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        SecondaryButton("Sign out", onSignOut, Modifier.fillMaxWidth().testTag("sign-out"), danger = true)
    }
}

private val previewEnvironment = AppEnvironment("https://preview.convex.site", "https://preview.convex.cloud")
@Preview(name = "Light", showBackground = true)
@Composable private fun LightPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
@Preview(name = "Dark", showBackground = true, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable private fun DarkPreview() = FieldApp(previewEnvironment, dark = true, debug = true)
@Preview(name = "Large font", showBackground = true, fontScale = 2f)
@Composable private fun LargeFontPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
