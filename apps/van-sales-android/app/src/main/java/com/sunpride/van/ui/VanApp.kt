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
import com.sunpride.van.scanning.SenraiseScanner
import kotlinx.coroutines.delay

@Composable fun VanApp(controller: VanController, dark: Boolean = false, restore: Boolean = true) {
    LaunchedEffect(controller) { controller.run(restore) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    // A suspended timer does not spin or block Compose. Checks stop on leaving this state.
    LaunchedEffect(controller,controller.enrollment) {
        while (controller.enrollment == EnrollmentState.Unregistered || controller.enrollment == EnrollmentState.Removed) {
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
    MaterialTheme(colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) {
        BackHandler(controller.page != Page.HOME) { controller.back() }
        when {
            !controller.initialized -> ScreenFrame("Sunpride Van") { Text("Getting your day ready…") }
            // SP-0125: the printer test needs no account, so a new handheld can be checked before setup.
            controller.page == Page.PRINTER && (!controller.session.signedIn || controller.enrollment !is EnrollmentState.Ready) ->
                PrinterScreen(controller)
            !controller.session.signedIn -> SignInScreen(controller)
            controller.enrollment !is EnrollmentState.Ready -> EnrollmentScreen(controller)
            else -> when (controller.page) {
                Page.HOME -> HomeScreen(controller)
                Page.LOAD -> CheckLoadScreen(controller)
                Page.START -> StartTripScreen(controller)
                Page.STOCK -> TruckStockScreen(controller)
                Page.STOCK_COUNT -> StockCountScreen(controller)
                Page.CUSTOMERS -> CustomersScreen(controller)
                Page.WALK_IN -> WalkInScreen(controller)
                Page.CUSTOMER -> CustomerDetailScreen(controller)
                Page.PRINTER -> PrinterScreen(controller)
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
        enabled = !c.busy && (c.environment.isReady || c.fixtureMode) && email.isNotBlank() && password.isNotEmpty(),
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
        ListRow("Test printer & scanner","Check this handheld before signing in","sign-in-printer",onClick = { c.open(Page.PRINTER) })
        c.features.reportIssueUrl?.let { url -> ListRow("Report an issue","Tell the Sunpride team what went wrong","report-issue",onClick = { openLink(context,url) }) }
    }
}
@Composable private fun EnrollmentScreen(c: VanController) {
    val removed = c.enrollment == EnrollmentState.Removed
    ScreenFrame(if (removed) "Phone removed" else "Register phone",action = if (c.busy) "Checking…" else "Check again",
        actionTag = "check-again",onAction = c::checkAgain,enabled = !c.busy,message = c.message) {
        Text(if (removed) "Ask your supervisor to re-add this phone. Your saved work has not been deleted."
            else "This phone is not registered yet. Send this phone code to your supervisor.")
        SectionCard("Phone code") { Text(c.fingerprint, style = MaterialTheme.typography.titleMedium, fontFamily = FontFamily.Monospace, modifier = Modifier.testTag("fingerprint")) }
        Text("We will check again automatically.",style = MaterialTheme.typography.bodyMedium)
        ListRow("Test printer & scanner","Check this handheld while you wait","enrollment-printer",onClick = { c.open(Page.PRINTER) })
        SecondaryButton("Sign out",c::signOut,enabled = !c.busy)
    }
}
@Composable private fun PrinterScreen(c: VanController) {
    val context = LocalContext.current
    // VAN-017: the shared printer (also used for sale receipts); the Activity owns and closes it.
    val scanner = remember { SenraiseScanner(context) }
    DisposableEffect(scanner) { onDispose { scanner.close() } }
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
