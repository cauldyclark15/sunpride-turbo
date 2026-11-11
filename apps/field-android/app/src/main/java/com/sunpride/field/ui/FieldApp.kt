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
import androidx.compose.foundation.layout.size
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
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.graphics.Color
import androidx.core.net.toUri
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.FieldFeature
import com.sunpride.field.FieldFeatures
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.ui.syncstatus.SyncDetails
import com.sunpride.field.ui.syncstatus.SupportDetails
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

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


/**
 * Store detail "Edit" (header Edit and the "Edit store" button). The form sends a change request linked to the
 * existing store (census.capture kind=change); the office approves it on the web New stores tab and Approve updates
 * that store, never a new one.
 */
const val STORE_EDIT_ENABLED = true

@Composable
fun FieldApp(
    environment: AppEnvironment, dark: Boolean, debug: Boolean = false, backend: FieldBackend? = null,
    onKeyLoaded: (DeviceKeyInfo) -> Unit = {},
    visitLocation: com.sunpride.field.ui.diagnosticvisit.VisitLocation? = null,
    // SP-0124: the build's feature list; `debug` alone keeps the old all-on / visits-off test shapes.
    features: FieldFeatures = if (debug) FieldFeatures.ALL else FieldFeatures.READ_ONLY,
    // SP-0128: fingerprint/face sign-in; null where the host has no FragmentActivity (tests, previews).
    biometrics: BiometricGate? = null,
    // SP-0140: the one-time battery/autostart guide for location sharing; null in tests that don't cover it.
    batteryGuide: com.sunpride.field.location.BatteryGuideHost? = null,
) {
    val visits = FieldFeature.VISITS in features
    // Name typed into an empty customer search, carried into the Add a store form.
    var censusName by rememberSaveable { mutableStateOf("") }
    // The store being edited in the store form (Store › Edit); null when adding a new store.
    var censusEdit by rememberSaveable { mutableStateOf<String?>(null) }
    // Edit store changes the office has not applied yet, by store id (label shown on the store page).
    var storeChanges by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    var storeChangesTick by remember { mutableStateOf(0) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val location = remember(visitLocation) { visitLocation ?: com.sunpride.field.ui.diagnosticvisit.AndroidVisitLocation(context) }
    val offline = com.sunpride.field.ui.syncstatus.rememberOffline()
    val controller = remember(backend) { FieldController(backend ?: UnconfiguredBackend, scope, onKeyLoaded = onKeyLoaded) }
    // SP-0140: "fully drawn" = the launch reached a usable screen (logcat `Fully drawn`, timed by
    // scripts/measure-performance.sh); a no-op where the host reports nothing (tests, previews).
    androidx.activity.compose.ReportDrawnWhen { controller.launchSettled }
    var page by rememberSaveable { mutableStateOf("home") }
    // Where a drill-down page (Account, Sync, a tool) opened from, so Back and the arrow return there.
    var origin by rememberSaveable { mutableStateOf("home") }
    // FLD-132: each page keeps its own remembered state (Stores search, list scroll) while you move between
    // tabs. A new session (sign-out, expiry, removal) starts a fresh epoch so nothing typed carries over.
    val pages = androidx.compose.runtime.saveable.rememberSaveableStateHolder()
    var pagesEpoch by rememberSaveable { mutableStateOf(0) }
    fun go(next: String) {
        if (page !in FieldNav.overlayPages) origin = page
        page = next
    }
    // The Messages list is drawn under the app header; a chat, search or picker brings its own bar instead.
    var chatAtRoot by remember { mutableStateOf(true) }
    var customerId by rememberSaveable { mutableStateOf<String?>(null) }
    val customer = customerId?.let { id -> controller.today.customers.firstOrNull { it.outletId == id } }
    LaunchedEffect(page, customerId, controller.today, storeChangesTick, backend) {
        if (page != "customer") return@LaunchedEffect
        val stores = controller.today.customers.associate { c -> c.outletId to com.sunpride.field.census.CensusRules.Current(
            c.name, (c.address ?: c.account?.address).orEmpty(), c.contactName.orEmpty(), c.contactPhone.orEmpty()) }
        val changes = try { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { backend?.storeChanges().orEmpty() } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { emptyList() }
        // The office's decisions (refreshed with each sync, since controller.today changes then): an accepted change
        // clears the label, a rejected one says "Change not accepted: <reason>" once on its store page.
        val decisions = if (changes.isEmpty()) emptyMap() else try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { backend?.storeDecisions().orEmpty() } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { emptyMap() }
        val seen = if (decisions.isEmpty()) emptySet() else try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { backend?.seenRejections().orEmpty() } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { emptySet() }
        storeChanges = com.sunpride.field.census.CensusRules.waitingChanges(changes, stores, System.currentTimeMillis(), decisions, seen)
        val shown = customerId?.let { com.sunpride.field.census.CensusRules.rejectionsToMark(changes, decisions, it, seen) }.orEmpty()
        if (shown.isNotEmpty()) try {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { backend?.markRejectionsSeen(shown) } }
            catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) {}
    }
    // SP-0128: a sealed session waits for the system prompt; the app starts once it is opened (or the
    // person chose the password), and again after a later successful unlock from the password screen.
    val locked = biometrics?.step == BiometricGate.Step.LOCKED
    LaunchedEffect(controller, locked, biometrics?.unlocks) {
        if (!locked) controller.start(configured = environment.isReady)
    }
    LaunchedEffect(biometrics) { if (biometrics?.step == BiometricGate.Step.LOCKED) biometrics.unlock() }
    // Only a real sign-out / session expiry (signed in → signed out) refreshes the gate; the launch itself must
    // keep the gate's message (e.g. "fingerprints changed").
    var wasSignedIn by remember { mutableStateOf(false) }
    LaunchedEffect(biometrics, controller.state) {
        val signedIn = controller.state != EnrollmentState.SignedOut
        if (wasSignedIn && !signedIn) biometrics?.signedOut()
        wasSignedIn = signedIn
    }
    val signOut = { controller.signOut(); biometrics?.signedOut(); page = "home"; Unit }
    // Whatever ends the session (sign-out, expiry, removal), the next person starts on a clean sign-in screen.
    LaunchedEffect(controller.state) { if (controller.state == EnrollmentState.SignedOut) { page = "home"; pagesEpoch++ } }
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
    // SP-0140: list screens only need minute precision; re-rendering every outlet row each second costs
    // CPU and battery on an entry-level phone. The sync pill keeps the 1-second clock.
    val minuteNow by remember { androidx.compose.runtime.derivedStateOf { now / 60_000 * 60_000 } }
    val ready = controller.state is EnrollmentState.Ready
    val status = controller.today.syncStatus.copy(offline = offline)
    // FLD-147: the upload worker runs outside the UI; when it finishes, refresh the pill and the Photos card.
    val photoRuns by com.sunpride.field.evidence.EvidenceWork.runs.collectAsState()
    LaunchedEffect(photoRuns) { if (photoRuns > 0 && ready) controller.photosChanged() }
    // F-616 prefetch after a verified snapshot/sync, never on every one-second UI pulse.
    LaunchedEffect(backend,ready,controller.today.lastSynced) {
        if(ready && controller.today.lastSynced!=null) kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
            val job=kotlin.coroutines.coroutineContext[kotlinx.coroutines.Job]
            runCatching { backend?.warmCatalogueImages { job?.isActive!=false } }
        }
    }
    // SP-0136 live map: the work day that bounds location sharing (consent, Start/End day, indicator).
    val workDayHost = remember(backend) { backend?.workDay }
    // Read off the main thread (it resolves the signed-in account through the encrypted session).
    var dayState by remember { mutableStateOf<com.sunpride.field.location.WorkDayView?>(null) }
    var dayRefresh by remember { mutableStateOf(0) }
    LaunchedEffect(workDayHost, ready, dayRefresh) {
        while (true) {
            dayState = if (!ready || workDayHost == null) null else runCatching {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { workDayHost.view(System.currentTimeMillis()) }
            }.getOrNull()
            delay(5_000)
        }
    }
    val dayView = dayState.takeIf { ready }
    // SP-0140: the phone's battery restriction, re-read with the day state (and after returning from Settings).
    var guideView by remember { mutableStateOf<com.sunpride.field.location.BatteryGuideView?>(null) }
    var resumes by remember { mutableStateOf(0) }
    val lifecycleOwner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    androidx.compose.runtime.DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) resumes++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(batteryGuide, ready, dayRefresh, dayState, page, resumes) {
        guideView = if (!ready || batteryGuide == null) null else runCatching {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { batteryGuide.view() }
        }.getOrNull()
    }
    /** After location is set up: the battery guide once per phone where it matters, else home. */
    fun afterLocationSetup() {
        val guide = batteryGuide ?: run { page = "home"; return }
        scope.launch {
            val show = runCatching {
                kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { guide.shouldShow() }
            }.getOrDefault(false)
            page = if (show) "location-battery" else "home"
        }
    }
    var dayBusy by remember { mutableStateOf(false) }
    var askedLocation by rememberSaveable { mutableStateOf(false) }
    fun dayAction(after: () -> Unit = {}, block: (com.sunpride.field.location.WorkDayHost, Long) -> Unit) {
        val host = workDayHost ?: return
        scope.launch {
            dayBusy = true
            runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { block(host, System.currentTimeMillis()) } }
            dayBusy = false; dayRefresh++
            after()
        }
    }
    val backgroundLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) { afterLocationSetup(); dayAction { h, t -> h.resume(t) } }
    val locationLauncher = androidx.activity.compose.rememberLauncherForActivityResult(
        androidx.activity.result.contract.ActivityResultContracts.RequestMultiplePermissions()) {
        askedLocation = true
        // The day starts either way: without permission the card and indicator say "Location off".
        dayAction(after = {
            val perms = com.sunpride.field.location.LocationShare.permissions(context)
            if (perms.location && !perms.background && Build.VERSION.SDK_INT >= 29) page = "location-background"
            else if (perms.location) afterLocationSetup() else page = "home"
        }) { h, t -> h.startDay(t) }
    }
    val requestLocation = { locationLauncher.launch(com.sunpride.field.ui.location.LocationPermissionRequest.permissions()) }
    // SP-0141: the phone's Back key and the on-screen ‹ take the same one step up; only Today (and the
    // sign-in / unlock / waiting screens) hand Back to the system, which leaves the app.
    val backStep = BackNavigation.step(BackState(locked = locked, signedIn = controller.state != EnrollmentState.SignedOut,
        ready = ready, page = page, origin = origin, visitOpen = controller.diagnostic != null, visitsEnabled = visits,
        photoCaptureOpen = controller.photoCaptureOpen, activityFormOpen = controller.activityForm != null,
        orderOpen = controller.orderOpen, orderReview = controller.orderReview, callSheetOpen = controller.callSheetOpen))
    val goBack: () -> Unit = {
        when (val step = backStep) {
            BackStep.ClosePhoto -> controller.closePhotoCapture()
            BackStep.CloseActivityForm -> controller.closeActivityForm()
            BackStep.CloseOrderReview -> controller.closeOrderReview()
            BackStep.CloseOrder -> controller.closeOrder()
            BackStep.CloseCallSheet -> controller.closeCallSheet()
            BackStep.CloseVisit -> controller.closeDiagnostic()
            is BackStep.ToPage -> {if(page=="workforce")controller.closeWorkforce();page = step.page}
            BackStep.Exit -> Unit
        }
    }
    androidx.activity.compose.BackHandler(enabled = backStep != BackStep.Exit, onBack = goBack)
    // SP-0147: a chat notification tap opens Messages at its conversation once the app is ready.
    val chatTap = com.sunpride.chat.ui.rememberChatLaunch()
    LaunchedEffect(chatTap, ready) { if (ready && chatTap != null) page = "messages" }
    // Opening the app (or coming back from Settings with permission) restarts a running day's service.
    LaunchedEffect(workDayHost, dayView?.started, dayView?.locationAllowed) {
        if (dayView?.started == true && dayView.locationAllowed) dayAction { h, t -> h.resume(t) }
    }
    val summaryUnread = if (ready) com.sunpride.field.chat.rememberFieldUnread() else 0
    val imeVisible = rememberImeVisible()
    // The visit screens take over the page the seller was on, exactly as the `when` below picks them.
    val visitOpen = controller.diagnostic != null && visits && ready && page !in FieldNav.pagesAheadOfVisit
    val barVisible = FieldNav.barVisible(ready, locked, controller.today.partnerMode, visitOpen, page) && !imeVisible
    MaterialTheme(colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        shapes = SunprideTokens.shapes, typography = SunprideTokens.typography) {
        Scaffold(contentWindowInsets = WindowInsets.safeDrawing, containerColor = MaterialTheme.colorScheme.background, topBar = {
            // SP-0147: Messages draws its own top bar (title, back, actions), so the app's bar steps aside there.
            if (com.sunpride.field.chat.FieldChat.appBarVisible(ready, page, chatAtRoot)) {
                val editStore = { censusEdit = customerId; go("census") }
                val spec = headerSpec(ready, locked, signedIn = controller.state != EnrollmentState.SignedOut, page = page,
                    visitOpen = visitOpen, controller = controller, routeCode = controller.today.routeCode,
                    editingStore = censusEdit != null).let {
                    // FLD-207: no header Edit while ANY call is open, not only while the visit screen shows.
                    val callOpen = controller.today.customers.any { c -> c.callOpen || c.today?.status == "In progress" }
                    if (STORE_EDIT_ENABLED && ready && !visitOpen && !callOpen && visits && page == "customer" && customer != null)
                        it.copy(action = HeaderAction("Edit", editStore, "customer-header-edit")) else it
                }
                FieldHeader(spec.title, subtitle = spec.subtitle, titleTag = spec.titleTag,
                    onBack = if (spec.back) goBack else null, backTag = spec.backTag,
                    actions = {
                        spec.action?.let { HeaderTextButton(it) }
                        if (controller.state != EnrollmentState.SignedOut && !locked) HeaderRoundButton(GlyphKind.PERSON, "Account",
                            { go("account") }, Modifier.testTag("account-open"))
                    },
                    below = if (ready) ({
                        // FlowRow: a long sync label pushes the location pill to its own line instead of squeezing it.
                        androidx.compose.foundation.layout.FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            val label = status.label(now)
                            StatusPill(label, Modifier.testTag("sync-status"), onClick = { go("sync") },
                                warning = status.review > 0 || status.held > 0 || label.startsWith("Late") || label.startsWith("Day closed"),
                                good = label == "All synced")
                            if (dayView != null) com.sunpride.field.ui.location.LocationIndicator(dayView)
                        }
                    }) else null)
            }
        }, bottomBar = {
            if (barVisible) FieldBottomBar(FieldNav.tabOf(page), summaryUnread, onSelect = { tab ->
                if (tab.page != page) { page = tab.page; origin = "home" }
            })
        }) { padding ->
            val modifier = Modifier.padding(padding).consumeWindowInsets(padding)
            pages.SaveableStateProvider("$pagesEpoch:$page") { when {
                locked -> UnlockScreen(biometrics!!.busy, onUnlock = biometrics::unlock,
                    onPassword = biometrics::usePassword, modifier = modifier)
                controller.state == EnrollmentState.SignedOut -> SignInScreen(environment, controller.busy || controller.companySignInPending,
                    controller.error ?: biometrics?.message,
                    { email, password -> controller.signIn(email, password) { biometrics?.passwordSignedIn(email) } }, modifier,
                    onBiometric = biometrics?.takeIf { it.canRetry }?.let { gate -> gate::unlock },
                    companyContent = { com.sunpride.integrity.CompanySignIn(environment.apiOrigin,"field-android",environment.isReady && !controller.busy,
                        controller::companyKey,controller::signCompanyMessage,controller::updateCompanyWaiting, { controller.companySignIn(it) }) })
                ready&&controller.today.partnerMode&&page !in setOf("account","support","change-password","sync") -> DsrScreen(controller,location,modifier)
                page == "account" -> AccountScreen(controller.key, signOut,
                    onBack = goBack, onSupport = { page = "support" }, modifier = modifier,
                    showKeyDetails = FieldFeature.PHONE_KEY_DETAILS in features,
                    onReportIssue = features.reportIssueUrl?.let { url -> { openLink(context, url) } },
                    biometrics = biometrics,
                                        onChangePassword = { controller.resetPasswordForm(); page = "change-password" },
                    onBatteryGuide = if (batteryGuide != null) ({ go("location-battery") }) else null,
                    sapContent = {
                        FieldCreditControlPanel(controller::creditControl,controller::sapMasterLifetime)
                        com.sunpride.catalogue.SapMasterCopy(controller::sapMasters,controller::sapMasterLifetime)
                        com.sunpride.integrity.AppUpdatePanel(controller::appUpdates,controller::sapMasterLifetime)
                    })
                ready && page == "incentives" -> androidx.compose.runtime.key(backend?.authorizationEpoch) {
                    com.sunpride.field.ui.incentives.EarnedStatementsScreen(backend, { page = origin }, modifier)
                }
                page == "change-password" -> ChangePasswordScreen(controller.passwordBusy, controller.passwordMessage,
                    controller.passwordChanged, onChange = { current, next, confirm ->
                        controller.changePassword(current, next, confirm) { biometrics?.passwordChanged() }
                    }, onDone = { page = "account" }, modifier = modifier)
                page == "support" -> SupportDetails(status, { page = "account" }, modifier)
                ready && page == "location-consent" -> com.sunpride.field.ui.location.LocationConsentScreen(
                    onAgree = { dayAction(after = requestLocation) { h, t -> h.consent(t) } },
                    onDecline = { page = origin }, modifier = modifier)
                ready && page == "location-background" -> com.sunpride.field.ui.location.BackgroundLocationScreen(
                    onOpenSettings = { backgroundLauncher.launch(android.Manifest.permission.ACCESS_BACKGROUND_LOCATION) },
                    onSkip = { afterLocationSetup() }, modifier = modifier)
                ready && page == "location-battery" && batteryGuide != null && guideView != null -> {
                    LaunchedEffect(Unit) {
                        runCatching { kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { batteryGuide.markShown() } }
                    }
                    com.sunpride.field.ui.location.BatteryGuideScreen(guideView!!,
                        onBattery = { batteryGuide.openBattery(context) },
                        onAutostart = { batteryGuide.openAutostart(context) },
                        onDone = { page = origin }, modifier = modifier)
                }
                ready && page == "collections" -> CollectorScreen(controller,modifier)
                ready && page == "jointcall" -> JointCallScreen(controller,modifier)
                ready && page == "catalogue" -> androidx.compose.runtime.key(backend?.authorizationEpoch) {
                    com.sunpride.field.catalogue.FieldCatalogue(backend, { page = origin }, modifier)
                }
                ready && page == "census" -> androidx.compose.runtime.key(backend?.authorizationEpoch) {
                    com.sunpride.field.census.CensusScreen(backend, location, { page = origin }, modifier,
                        stores = controller.today.customers, onOpenStore = { id -> customerId = id; page = "customer" },
                        initialName = censusName,
                        editing = censusEdit?.let { id -> controller.today.customers.firstOrNull { it.outletId == id } },
                        onChangeSaved = { censusEdit = null; storeChangesTick++; page = "customer" })
                }
                ready && page == "workforce" -> com.sunpride.field.ui.workforce.WorkforceScreen(controller,location,modifier)
                // SP-0146 v2 messaging: the shared chat module; Back inside it steps back, Back on its list returns here.
                ready && page == "messages" -> com.sunpride.field.chat.FieldMessages(modifier, chatTap, onClose = { page = "home" }, onAtRoot = { chatAtRoot = it },
                    openHref = { href ->
                        Regex("^/stores/([^/?#]+)").find(href)?.groupValues?.get(1)
                            ?.takeIf { id -> controller.today.customers.any { it.outletId == id } }
                            ?.let { id -> customerId = id; page = "customer"; true } ?: false
                    })
                ready && page == "sync" -> SyncDetails(status, onDismiss = { page = origin },
                    onSync = controller::syncNow, busy = controller.busy, modifier = modifier)
                ready && page == "more" -> MoreScreen(modifier = modifier, status = status, now = now,
                    onSync = { go("sync") }, onAccount = { go("account") }, onSupport = { go("support") },
                    onCatalogue = { go("catalogue") }, onCensus = if (visits) ({ censusName = ""; censusEdit = null; go("census") }) else null,
                    onWorkforce = { controller.openWorkforce(); go("workforce") },
                    onJointCall = if (controller.today.supervisor) ({ go("jointcall") }) else null,
                    onCollections = { go("collections") },
                    onTeam = if (FieldFeature.TEAM in features && controller.today.supervisor) ({ go("team") }) else null,
                    onIncentives = { go("incentives") },
                    onBatteryGuide = if (batteryGuide != null) ({ go("location-battery") }) else null,
                    onReportIssue = features.reportIssueUrl?.let { url -> { openLink(context, url) } },
                    onSignOut = signOut)
                controller.diagnostic != null && visits && ready && controller.photoCaptureOpen ->
                    com.sunpride.field.ui.diagnosticvisit.PhotoCaptureScreen(controller, modifier)
                controller.diagnostic != null && visits && ready && controller.activityForm != null ->
                    com.sunpride.field.ui.diagnosticvisit.ActivityFormScreen(controller.activityForm!!, controller, modifier)
                controller.diagnostic != null && visits && ready && controller.orderOpen && controller.orderReview ->
                    com.sunpride.field.ui.orders.OrderReviewScreen(controller.diagnostic!!, controller, modifier)
                controller.diagnostic != null && visits && ready && controller.orderOpen && controller.diagnosticCallSheet != null ->
                    com.sunpride.field.ui.orders.OrderDraftScreen(controller.diagnostic!!, controller.diagnosticCallSheet!!,
                        controller, modifier)
                controller.diagnostic != null && visits && ready && controller.callSheetOpen && controller.diagnosticCallSheet != null ->
                    com.sunpride.field.ui.diagnosticvisit.CallSheetScreen(controller.diagnosticCallSheet!!, controller, modifier)
                controller.diagnostic != null && visits && ready -> com.sunpride.field.ui.diagnosticvisit.DiagnosticVisitScreen(
                    controller.diagnostic!!, controller, location, controller::closeDiagnostic, modifier)
                ready && page == "route" -> com.sunpride.field.ui.route.RouteScreen(controller.today, location,
                    onNavigate = { uri -> openMaps(context, uri) }, modifier = modifier,
                    onVisit = controller::openDiagnostic, visitEnabled = visits, offline = offline,
                    onAddVisit = if (visits && FieldFeature.UNPLANNED_VISITS in features) ({ page = "customers" }) else null)
                ready && page == "customers" -> com.sunpride.field.ui.customers.CustomerSearchScreen(controller.today,
                    onOpen = { id -> customerId = id; page = "customer" }, modifier = modifier, offline = offline, now = minuteNow,
                    onAddStore = if (visits) ({ typed -> censusName = typed; censusEdit = null; go("census") }) else null)
                ready && page == "customer" && customer != null -> com.sunpride.field.ui.customers.CustomerDetailScreen(
                    customer, controller.today, onNavigate = { uri -> openMaps(context, uri) },
                    onDial = { uri -> openDialer(context, uri) }, modifier = modifier,
                    onVisit = controller::openDiagnostic, visitEnabled = visits, now = minuteNow,
                    unplannedEnabled = FieldFeature.UNPLANNED_VISITS in features,
                    onEdit = if (visits && STORE_EDIT_ENABLED) ({ censusEdit = customerId; go("census") }) else null,
                    changeLabel = storeChanges[customer.outletId])
                ready && page == "customer" -> com.sunpride.field.ui.customers.CustomerSearchScreen(controller.today,
                    onOpen = { id -> customerId = id; page = "customer" }, modifier = modifier, offline = offline, now = minuteNow,
                    onAddStore = if (visits) ({ typed -> censusName = typed; censusEdit = null; go("census") }) else null)
                ready && page == "team" -> com.sunpride.field.ui.team.TeamScreen(controller.team,
                    controller.teamDirectOnly, controller.teamLoading, minuteNow,
                    onFilter = { controller.loadTeam(it) }, onRefresh = { controller.loadTeam() }, modifier = modifier)
                ready -> TodayScreen(controller.today, controller.busy,
                    onSync = controller::syncNow, onSignOut = signOut,
                    onVisit = controller::openDiagnostic, diagnosticEnabled = visits, modifier = modifier, offline = offline,
                    unplannedEnabled = FieldFeature.UNPLANNED_VISITS in features,
                    onRoute = { page = "route" }, onCustomers = { page = "customers" },
                    onTeam = if (FieldFeature.TEAM in features) ({ go("team") }) else null,
                    showTitle = false,
                    onAddStore = if (visits) ({ censusName = ""; censusEdit = null; go("census") }) else null,
                    workDay = {
                        dayView?.let { view ->
                        com.sunpride.field.ui.location.WorkDayCard(view, dayBusy,
                            onStart = {
                                when {
                                    !view.consented -> go("location-consent")
                                    !view.locationAllowed -> requestLocation()
                                    else -> dayAction(after = { afterLocationSetup() }) { h, t -> h.startDay(t) }
                                }
                            },
                            onKeepSharing = guideView?.takeIf {
                                com.sunpride.field.location.BatteryGuideRules.offerAgain(view.sharing, it.unrestricted)
                            }?.let { { go("location-battery") } },
                            onEnd = { dayAction { h, t -> h.endDay(t) } },
                            onAllowLocation = {
                                if (!askedLocation) requestLocation()
                                else openLink(context, "package:${context.packageName}",
                                    android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                            })
                    } })
                else -> EnrollmentScreen(controller.state, controller.key, controller.busy, controller.error,
                    onCheck = { controller.checkAgain() }, onSignOut = signOut, modifier = modifier,
                    unsent = status.queued + status.sending + status.review + status.held,
                    pairingContent = {com.sunpride.integrity.ReplacementPairing(controller::replacementCode)})
            } }
        }
        if (biometrics != null && biometrics.offer && controller.state != EnrollmentState.SignedOut) BiometricOffer(
            onAccept = biometrics::enable, onDecline = biometrics::decline)
    }
}

/** SP-0128: shown once after a password sign-in when the phone has a strong fingerprint/face enrolled. */
@Composable
private fun BiometricOffer(onAccept: () -> Unit, onDecline: () -> Unit) {
    androidx.compose.material3.AlertDialog(onDismissRequest = onDecline,
        modifier = Modifier.testTag("biometric-offer"),
        title = { Text("Use fingerprint or face to sign in next time?", style = MaterialTheme.typography.titleMedium) },
        text = { Text("Your password is never saved on this phone. You can turn this off in Account.",
            style = MaterialTheme.typography.bodyMedium) },
        confirmButton = { TextButton(onClick = onAccept, modifier = Modifier.testTag("biometric-offer-accept")) {
            Text("Turn on") } },
        dismissButton = { TextButton(onClick = onDecline, modifier = Modifier.testTag("biometric-offer-decline")) {
            Text("Not now") } })
}

/** SP-0128 launch lock: the system prompt sits on top; these buttons retry it or go to the password. */
@Composable
private fun UnlockScreen(busy: Boolean, onUnlock: () -> Unit, onPassword: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically)) {
            SunprideLogo(Modifier.testTag("unlock-logo"), 72.dp)
            Text("Welcome back", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("unlock-title"))
            Text("Use your fingerprint or face to open the app.", style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
        }
        ActionBar {
            PrimaryBottomButton("Use fingerprint or face", onUnlock, Modifier.testTag("unlock-biometric"), !busy)
            SecondaryButton("Sign in with password", onPassword, Modifier.fillMaxWidth().testTag("unlock-password"))
        }
    }
}

/** Opens a web page (the issue tracker) in the browser; false when nothing can open it. */
private fun openLink(context: Context, url: String, action: String = android.content.Intent.ACTION_VIEW): Boolean = try {
    context.startActivity(android.content.Intent(action, url.toUri())
        .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: android.content.ActivityNotFoundException) { false }

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

/** SP-0126: the client's logo exactly as supplied (packages/ui/assets/sunpride-logo.jpg), never recoloured. */
@Composable
fun SunprideLogo(modifier: Modifier = Modifier, size: androidx.compose.ui.unit.Dp = 96.dp) {
    androidx.compose.foundation.Image(androidx.compose.ui.res.painterResource(com.sunpride.field.R.drawable.sunpride_logo),
        contentDescription = "Sunpride", modifier = modifier.size(size).clip(MaterialTheme.shapes.large))
}

@Composable
private fun SignInScreen(environment: AppEnvironment, busy: Boolean, error: String?,
    onSignIn: (String, String) -> Unit, modifier: Modifier = Modifier, onBiometric: (() -> Unit)? = null,
    companyContent: (@Composable () -> Unit)? = null) {
    var email by rememberSaveable { mutableStateOf("") }
    // Never saved: the password and its visibility live only while this screen is shown.
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    val lifecycle = androidx.lifecycle.compose.LocalLifecycleOwner.current.lifecycle
    androidx.compose.runtime.DisposableEffect(lifecycle) {
        // SP-0128: leaving the app (home, recents, screen off) hides the password again.
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_STOP) showPassword = false
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    Column(modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                SunprideLogo(Modifier.testTag("sign-in-logo"), 64.dp)
                Column {
                    Text("Sign in", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("shell-title"))
                    Text("Use your Sunpride work account.", style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (!environment.isReady) SectionCard("Configuration required", Modifier.testTag("environment-error")) {
                environment.errors.forEach { Text(it, Modifier.padding(16.dp)) }
            }
            LabeledField("Email", email, { email = it }, Modifier.fillMaxWidth().testTag("email"), !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email))
            LabeledField("Password", password, { password = it }, Modifier.fillMaxWidth().testTag("password"), !busy,
                visualTransformation = if (showPassword) androidx.compose.ui.text.input.VisualTransformation.None
                    else PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                trailingIcon = {
                    val label = if (showPassword) "Hide password" else "Show password"
                    IconButton(onClick = { showPassword = !showPassword },
                        modifier = Modifier.testTag("password-toggle").semantics { contentDescription = label }) {
                        EyeGlyph(crossed = showPassword)
                    }
                })
            if (error != null) NoticeCard(error, tone = Look.Tone.BAD, textTag = "auth-error")
            if (companyContent != null) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = Look.hairline)
                    Text("or", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    androidx.compose.material3.HorizontalDivider(Modifier.weight(1f), color = Look.hairline)
                }
                companyContent.invoke()
            }
        }
        ActionBar {
            if (onBiometric != null) SecondaryButton("Use fingerprint or face", onBiometric, Modifier.fillMaxWidth().testTag("sign-in-biometric"), !busy)
            PrimaryBottomButton(if (busy) "Signing in…" else "Sign in", {
                val secret = password; password = ""; showPassword = false; onSignIn(email.trim(), secret)
            }, Modifier.testTag("sign-in"), environment.isReady && !busy && email.isNotBlank() && password.isNotEmpty())
        }
    }
}

@Composable
fun EnrollmentScreen(state: EnrollmentState, key: DeviceKeyInfo?, busy: Boolean, error: String?,
    onCheck: () -> Unit, onSignOut: () -> Unit, modifier: Modifier = Modifier, unsent: Int = 0,
    pairingContent: (@Composable ()->Unit)? = null) {
    val context = LocalContext.current
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (state == EnrollmentState.Removed) "Phone removed" else "Register phone",
                    style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("enrollment-title"))
                Text(if (state == EnrollmentState.Removed) "Ask your admin to re-add this phone"
                    else "Send this code to your admin", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (state == EnrollmentState.Unregistered) {
                NoticeCard("Waiting for your admin. This screen checks again by itself.", tone = Look.Tone.WARN, glyph = GlyphKind.CLOCK)
                if (key != null) SectionCard("Phone code") {
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(key.fingerprint.filter { it.isLetterOrDigit() }.chunked(4).joinToString(" "),
                            fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.titleLarge,
                            modifier = Modifier.testTag("key-fingerprint"))
                        TonalButton(if (expanded) "Hide full code" else "Show full code", { expanded = !expanded },
                            Modifier.testTag("show-full-code"))
                        if (expanded) SelectionContainer { Text(key.publicKey, fontFamily = FontFamily.Monospace,
                            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("public-key")) }
                    }
                } else if (busy) CircularProgressIndicator(Modifier.testTag("key-loading"))
                if (pairingContent != null) SectionCard("Replacing another phone?") {
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp)) { pairingContent() }
                }
            }
            if (state == EnrollmentState.Removed) {
                if (unsent > 0) NoticeCard("$unsent unsent on this phone", tone = Look.Tone.WARN)
            }
            if (error != null) NoticeCard(error, tone = Look.Tone.BAD, textTag = "auth-error")
        }
        ActionBar {
            if (state == EnrollmentState.Unregistered) {
                PrimaryBottomButton("Copy code", {
                    key?.let { (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager)
                        .setPrimaryClip(ClipData.newPlainText("Phone code", it.publicKey)) }
                }, Modifier.testTag("copy-key"), key != null)
                SecondaryButton("Check again", onCheck, Modifier.fillMaxWidth().testTag("check-again"), !busy)
            } else {
                PrimaryBottomButton(if (busy) "Checking…" else "Check again", onCheck,
                    Modifier.testTag("check-again-primary"), !busy)
                SecondaryButton("Sign out", onSignOut, Modifier.fillMaxWidth().testTag("sign-out"), !busy, danger = true)
            }
        }
    }
}

@Composable
fun AccountScreen(key: DeviceKeyInfo?, onSignOut: () -> Unit, onBack: () -> Unit,
    onSupport: () -> Unit = {}, modifier: Modifier = Modifier, showKeyDetails: Boolean = true,
    onReportIssue: (() -> Unit)? = null, biometrics: BiometricGate? = null, onChangePassword: (() -> Unit)? = null, onBatteryGuide: (() -> Unit)? = null,
    sapContent: (@Composable ()->Unit)? = null) {
    Column(modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (biometrics != null) BiometricSetting(biometrics)
            if (sapContent != null) SectionCard("Credit and updates") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    sapContent()
                }
            }
            if (onChangePassword != null) SectionCard("Password") {
                ListRow("Change password", "Keep your account safe", "lock", Modifier.testTag("change-password-open"),
                    onClick = onChangePassword)
            }
            if (onBatteryGuide != null) SectionCard("Location sharing") {
                ListRow("Keep the app running", "Battery and background settings", "battery",
                    Modifier.testTag("account-battery-guide"), onClick = onBatteryGuide)
            }
            SectionCard("Support") {
                if (onReportIssue != null) ListRow("Report an issue", "Tell the Sunpride team what went wrong", "chat",
                    Modifier.testTag("report-issue"), onClick = onReportIssue)
                ListRow("Support info", "App version and counts to share with the team", "info", Modifier.testTag("support-info"), onClick = onSupport)
            }
            SectionCard("This phone") {
                ValueRow("Model", if (Build.MODEL.startsWith("sdk_")) "Android emulator" else Build.MODEL, Modifier.testTag("device-info"))
                ValueRow("OS", "Android ${Build.VERSION.RELEASE}")
                ValueRow("App version", BuildConfig.VERSION_NAME)
                if (showKeyDetails) ValueRow("Key storage", key?.protection ?: "Unavailable", Modifier.testTag("key-storage"))
                if (showKeyDetails) ValueRow("Fingerprint", key?.fingerprint ?: "Unavailable")
            }
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        SecondaryButton("Sign out", onSignOut, Modifier.fillMaxWidth().testTag("sign-out"), danger = true)
    }
}

/** SP-0128 Account toggle: off returns the session to the ordinary store; on asks for the prompt once. */
@Composable
private fun BiometricSetting(gate: BiometricGate) {
    val availability = remember(gate) { gate.availability() }
    val usable = availability == com.sunpride.field.auth.BiometricAvailability.AVAILABLE
    SectionCard("Sign-in") {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("Fingerprint or face sign-in", style = MaterialTheme.typography.bodyMedium)
                Text(when {
                    gate.enabled -> "On · your password is never saved"
                    availability == com.sunpride.field.auth.BiometricAvailability.NOT_ENROLLED ->
                        "Add a fingerprint in your phone's Settings first"
                    !usable -> "Not available on this phone"
                    else -> "Off"
                }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("biometric-status"))
            }
            androidx.compose.material3.Switch(checked = gate.enabled,
                onCheckedChange = { on -> if (on) gate.enable() else gate.disable() },
                enabled = !gate.busy && (gate.enabled || usable),
                modifier = Modifier.testTag("biometric-toggle").semantics {
                    contentDescription = "Fingerprint or face sign-in" })
        }
        gate.message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp).testTag("biometric-message")) }
    }
}

/** What the red header says: title, subtitle, the tags the device tests look for, and whether it has a Back arrow. */
private data class HeaderSpec(val title: String, val subtitle: String? = null, val titleTag: String? = null,
    val back: Boolean = false, val backTag: String? = null, val action: HeaderAction? = null)

private fun headerSpec(ready: Boolean, locked: Boolean, signedIn: Boolean, page: String, visitOpen: Boolean,
    controller: FieldController, routeCode: String?, editingStore: Boolean = false): HeaderSpec = when {
    locked || !signedIn -> HeaderSpec("Sunpride Field")
    // A phone still waiting for registration can open Account, Support and Sync, so those keep their own header.
    !ready && page !in setOf("account", "support", "sync", "change-password") -> HeaderSpec("Sunpride Field")
    // The store stays in the header through every step of its visit; the step is the subtitle.
    visitOpen -> HeaderSpec(controller.diagnostic?.outlet ?: "Visit",
        subtitle = if (controller.photoCaptureOpen || controller.activityForm != null || controller.orderOpen ||
            controller.callSheetOpen) null else "Visit",
        back = true, backTag = "visit-back")
    else -> when (page) {
        "home" -> HeaderSpec("Today", listOfNotNull(java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).format(
            java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d", java.util.Locale.ENGLISH)),
            routeCode?.let { "Route $it" }).joinToString(" · "), "today-title")
        "route" -> HeaderSpec("Route", titleTag = "route-title")
        "customers" -> HeaderSpec("Stores", titleTag = "customers-title")
        "customer" -> HeaderSpec("Store", titleTag = "customer-title", back = true, backTag = "customer-back")
        "more" -> HeaderSpec("More")
        "messages" -> HeaderSpec("Messages")
        "account" -> HeaderSpec("Account", titleTag = "account-title", back = true, backTag = "account-back")
        "sync" -> HeaderSpec("Sync", back = true, backTag = "sync-back")
        "support" -> HeaderSpec("Support info", back = true, backTag = "support-back")
        "change-password" -> HeaderSpec("Change password", back = true, backTag = "account-back")
        "team" -> HeaderSpec("Team", titleTag = "team-title", back = true, backTag = "team-back")
        "census" -> HeaderSpec(if (editingStore) "Edit store" else "Add store", back = true, backTag = "account-back")
        "workforce" -> HeaderSpec("Attendance", back = true, backTag = "workforce-back")
        "jointcall" -> HeaderSpec("Work-With", back = true, backTag = "account-back")
        "collections" -> HeaderSpec("Collector", back = true, backTag = "account-back")
        "catalogue" -> HeaderSpec("Products", back = true, backTag = "account-back")
        "incentives" -> HeaderSpec("Earned statements", back = true, backTag = "account-back")
        "location-consent", "location-background" -> HeaderSpec("Location sharing", back = true, backTag = "account-back")
        "location-battery" -> HeaderSpec("Keep sharing on", back = true, backTag = "account-back")
        else -> HeaderSpec("Sunpride Field")
    }
}


private val previewEnvironment = AppEnvironment("https://sunpride.cauldnclark.com")
@Preview(name = "Light", showBackground = true)
@Composable private fun LightPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
@Preview(name = "Dark", showBackground = true, uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Composable private fun DarkPreview() = FieldApp(previewEnvironment, dark = true, debug = true)
@Preview(name = "Large font", showBackground = true, fontScale = 2f)
@Composable private fun LargeFontPreview() = FieldApp(previewEnvironment, dark = false, debug = true)
