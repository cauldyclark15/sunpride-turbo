package com.sunpride.van.ui

import androidx.activity.compose.BackHandler
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.R
import com.sunpride.van.auth.EnrollmentState
import com.sunpride.van.printing.*
import com.sunpride.van.scanning.LocalScannerInput
import com.sunpride.van.scanning.ScannerInput
import kotlinx.coroutines.delay

@Composable fun VanApp(controller: VanController, dark: Boolean = false, restore: Boolean = true, scannerInput: ScannerInput? = null) {
    LaunchedEffect(controller) { controller.run(restore) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // IP-HH1: one scanner for the whole app (the Activity can pass its own so it also receives wedge key bursts).
    val appContext = LocalContext.current.applicationContext
    val scanner = scannerInput ?: remember(appContext) { ScannerInput(appContext) }
    DisposableEffect(scanner,lifecycle) {
        val observer = LifecycleEventObserver { _,event -> if (event == Lifecycle.Event.ON_START) scanner.start() else if (event == Lifecycle.Event.ON_STOP) scanner.stop() }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) scanner.start()
        onDispose { lifecycle.removeObserver(observer); scanner.stop() }
    }
    // A suspended timer does not spin or block Compose. Checks stop on leaving this state.
    LaunchedEffect(controller,controller.enrollment) {
        while (controller.enrollment == EnrollmentState.Unregistered || controller.enrollment == EnrollmentState.Removed ||
            controller.session.signedIn && controller.enrollment == EnrollmentState.SignedOut) {
            delay(15_000)
            if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) controller.checkAgain()
        }
    }
    // SP-0137: permission or the location switch may have changed in Settings while the app was away.
    DisposableEffect(lifecycle,controller) {
        val observer = LifecycleEventObserver { _,event -> if (event == Lifecycle.Event.ON_RESUME) controller.refreshSharing() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    CompositionLocalProvider(LocalScannerInput provides scanner) {
    MaterialTheme(colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) {
        BackHandler(controller.page != Page.HOME) { controller.back() }
        val chatTap = com.sunpride.van.chat.rememberVanChatLaunch()
        when {
            !controller.initialized -> ScreenFrame("Sunpride Van") { Text("Getting your day ready…") }
            // SP-0125: the printer test needs no account, so a new handheld can be checked before setup.
            controller.page == Page.PRINTER && (!controller.session.signedIn || controller.enrollment !is EnrollmentState.Ready) ->
                PrinterScreen(controller)
            !controller.session.signedIn -> SignInScreen(controller)
            controller.enrollment !is EnrollmentState.Ready -> EnrollmentScreen(controller)
            // SP-0146 v2 messaging: the shared chat module, opened from Home; Back inside it steps back, Back on its list returns Home.
            com.sunpride.van.chat.VanChat.open && !controller.storeMode -> com.sunpride.van.chat.VanMessages(chatTap)
            controller.storeMode && controller.page !in setOf(Page.ACCOUNT,Page.CHANGE_PASSWORD,Page.PRINTER,Page.SYNC,Page.STORE_OPEN,Page.STORE_CLOSE,Page.POS_MODE,Page.STORE_SALE,Page.STORE_READS,Page.STORE_RECEIPTS,Page.STORE_STOCK,Page.STORE_DEPOSIT,Page.STORE_CUSTOMERS) -> StoreHomeScreen(controller)
            else -> when (controller.page) {
                Page.STORE_SALE -> StoreSaleScreen(controller)
                Page.STORE_READS -> StoreReadsScreen(controller)
                Page.STORE_RECEIPTS -> StoreReceiptsScreen(controller)
                Page.STORE_STOCK -> StoreStockScreen(controller)
                Page.STORE_DEPOSIT -> StoreDepositScreen(controller)
                Page.STORE_CUSTOMERS -> StoreCustomersScreen(controller)
                Page.STORE_OPEN -> OpenSessionScreen(controller)
                Page.STORE_CLOSE -> CloseSessionScreen(controller)
                Page.POS_MODE -> PosModeScreen(controller)
                Page.ACCOUNT -> AccountScreen(controller)
                Page.CHANGE_PASSWORD -> ChangePasswordScreen(controller)
                Page.HOME -> HomeScreen(controller)
                Page.ROUTE_OPS -> RouteOpsScreen(controller)
                Page.LOAD -> CheckLoadScreen(controller)
                Page.START -> StartTripScreen(controller)
                Page.STOCK -> TruckStockScreen(controller)
                Page.STOCK_COUNT -> StockCountScreen(controller)
                Page.CUSTOMERS -> CustomersScreen(controller)
                Page.WALK_IN -> WalkInScreen(controller)
                Page.CUSTOMER -> CustomerDetailScreen(controller)
                Page.PRINTER -> PrinterScreen(controller)
                Page.CATALOGUE -> VanCatalogue(controller)
                Page.PRODUCTS -> ProductSearchScreen(controller)
                Page.SALE -> SaleScreen(controller)
                Page.CHECKOUT -> CheckoutScreen(controller)
                Page.SALE_DONE -> SaleDoneScreen(controller)
                Page.RETURN -> ReturnScreen(controller)
                Page.RETURN_DONE -> ReturnDoneScreen(controller)
                Page.RECEIPTS -> ReceiptsScreen(controller)
                Page.CASH -> CashCountScreen(controller)
                Page.CLOSE_TRIP -> CloseTripScreen(controller)
                Page.SYNC -> SyncHealthScreen(controller)
                Page.LOCATION_CONSENT -> LocationConsentScreen(controller)
            }
        }
        // IP-P0: asked after every print, on whichever screen the cashier is on.
        controller.printQuestionSaleId?.let { DidItPrintSheet(controller) }
    }
    }
}
@Composable private fun SignInScreen(c: VanController) {
    var email by remember { mutableStateOf("") }
    // Never save the password to SavedState or a persistent draft.
    var password by remember { mutableStateOf("") }
    // SP-0125 password eye: hidden by default, never saved, hidden again when the app is left or the form is sent.
    var showPassword by remember { mutableStateOf(false) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _,event -> if (event == Lifecycle.Event.ON_STOP) showPassword = false }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    val context = LocalContext.current
    ScreenFrame("Sign in",action = if (c.busy) "Signing in…" else "Sign in",actionTag = "sign-in",
        enabled = !c.busy && !c.companySignInPending && (c.environment.isReady || c.fixtureMode) && email.isNotBlank() && password.isNotEmpty(),
        onAction = { val secret = password; password = ""; showPassword = false; c.signIn(email,secret) },message = c.message) {
        Image(painterResource(R.drawable.sunpride_logo),contentDescription = "Sunpride",
            modifier = Modifier.size(96.dp).clip(SunprideTokens.shapes.large).testTag("sign-in-logo"))
        Text("Sunpride Van",style = MaterialTheme.typography.headlineMedium)
        Text("Your trip, load and customers on this phone.")
        if (!c.environment.isReady && !c.fixtureMode) SectionCard("Setup needed") { Text("This phone is not connected to the office yet. Ask your supervisor to finish setup.",Modifier.testTag("configuration-warning")) }
        if (c.fixtureMode) Text("Practice data · not connected to the office",style = MaterialTheme.typography.bodyMedium)
        LabeledField("Email",email,{ email = it },"email",enabled = !c.busy,maxLength = 254)
        LabeledField("Password",password,{ password = it },"password",password = true,enabled = !c.busy,maxLength = 1024,
            revealed = showPassword,onToggleReveal = { showPassword = !showPassword })
        com.sunpride.integrity.CompanySignIn(c.environment.siteUrl,"van-android",c.environment.isReady && !c.busy,
            c::companyKey,c::signCompanyMessage,c::updateCompanyWaiting,{ c.companySignIn(it) })
        ListRow("Test printer & scanner","Check this handheld before signing in","sign-in-printer",onClick = { c.open(Page.PRINTER) })
        c.features.reportIssueUrl?.let { url -> ListRow("Report an issue","Tell the Sunpride team what went wrong","report-issue",onClick = { openLink(context,url) }) }
    }
}
@Composable private fun EnrollmentScreen(c: VanController) {
    val removed = c.enrollment == EnrollmentState.Removed
    // Signed in but the phone check never reached the office (offline): unknown, never "not registered".
    if (c.enrollment == EnrollmentState.SignedOut) {
        ScreenFrame("Checking phone",action = if (c.busy) "Checking…" else "Check again",actionTag = "check-again",
            onAction = c::checkAgain,enabled = !c.busy,message = c.message) {
            Text("Could not reach the office to check this phone. Your saved work is kept here.",modifier = Modifier.testTag("enrollment-offline"))
            Text("We will check again automatically.",style = MaterialTheme.typography.bodyMedium)
            ListRow("Test printer & scanner","Check this handheld while you wait","enrollment-printer",onClick = { c.open(Page.PRINTER) })
            SecondaryButton("Sign out",c::signOut,enabled = !c.busy)
        }
        return
    }
    ScreenFrame(if (removed) "Handheld not set up" else "Register phone",action = if (c.busy) "Checking…" else "Check again",
        actionTag = "check-again",onAction = c::checkAgain,enabled = !c.busy,message = c.message) {
        Text(if (removed) UserMessages.NOT_SET_UP + " Your saved work has not been deleted."
            else "This phone is not registered yet. Send this phone code to your supervisor.")
        if (removed) CallSupervisorButton(c,"removed-call")
        SectionCard("Phone code") { Text(c.fingerprint, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("fingerprint")) }
        if (!removed) com.sunpride.integrity.ReplacementPairing(c::replacementCode)
        if (!removed) c.publicKey?.let { key ->
            val context = LocalContext.current
            ListRow("Send phone key","Share it with your supervisor to register this phone","share-phone-key",onClick = {
                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                    .putExtra(Intent.EXTRA_TEXT,"Sunpride Van phone key: $key"),"Send phone key").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            })
            Text(key,style = MaterialTheme.typography.bodySmall,fontFamily = FontFamily.Monospace,modifier = Modifier.testTag("phone-key"))
        }
        Text("We will check again automatically.",style = MaterialTheme.typography.bodyMedium)
        ListRow("Test printer & scanner","Check this handheld while you wait","enrollment-printer",onClick = { c.open(Page.PRINTER) })
        SecondaryButton("Sign out",c::signOut,enabled = !c.busy)
    }
}
@Composable private fun PrinterScreen(c: VanController) {
    // VAN-017: the shared printer (also used for sale receipts); the Activity owns and closes it. The scanner is the app's one.
    val scanner = checkNotNull(LocalScannerInput.current)
    ScreenFrame("Settings",c::back,action = "Done",onAction = c::back,actionTag = "printer-done",scroll = false) {
        PrinterTestScreen(c.printer,scanner,Modifier.fillMaxSize(),lastPrint = c.lastPrint?.let { last ->
            java.time.Instant.ofEpochMilli(last.at).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("h:mm a")) + " · " + last.text
        })
    }
}

/** Opens a web page (the beta issue form) in the browser; false when nothing can open it. */
internal fun openLink(context: Context, url: String): Boolean = try {
    context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    true
} catch (_: ActivityNotFoundException) { false }
