package com.sunpride.van.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
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
    MaterialTheme(colorScheme = if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors,
        typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) {
        BackHandler(controller.page != Page.HOME) { controller.back() }
        when {
            !controller.initialized -> ScreenFrame("Sunpride Van") { Text("Getting your day ready…") }
            !controller.session.signedIn -> SignInScreen(controller)
            controller.enrollment !is EnrollmentState.Ready -> EnrollmentScreen(controller)
            else -> when (controller.page) {
                Page.HOME -> HomeScreen(controller)
                Page.LOAD -> CheckLoadScreen(controller)
                Page.START -> StartTripScreen(controller)
                Page.STOCK -> TruckStockScreen(controller)
                Page.CUSTOMERS -> CustomersScreen(controller)
                Page.WALK_IN -> WalkInScreen(controller)
                Page.CUSTOMER -> CustomerDetailScreen(controller)
                Page.PRINTER -> PrinterScreen(controller)
                Page.PRODUCTS -> ProductSearchScreen(controller)
                Page.SALE -> SaleScreen(controller)
                Page.CHECKOUT -> CheckoutScreen(controller)
                Page.SALE_DONE -> SaleDoneScreen(controller)
            }
        }
    }
}
@Composable private fun SignInScreen(c: VanController) {
    var email by remember { mutableStateOf("") }
    // Never save the password to SavedState or a persistent draft.
    var password by remember { mutableStateOf("") }
    ScreenFrame("Sign in",action = if (c.busy) "Signing in…" else "Sign in",actionTag = "sign-in",
        enabled = !c.busy && (c.environment.isReady || c.fixtureMode) && email.isNotBlank() && password.isNotEmpty(),
        onAction = { val secret = password; password = ""; c.signIn(email,secret) },message = c.message) {
        Text("Sunpride Van",style = MaterialTheme.typography.headlineMedium)
        Text("Your trip, load and customers on this phone.")
        if (!c.environment.isReady && !c.fixtureMode) SectionCard("Setup needed") { Text("This phone is not connected to the office yet. Ask your supervisor to finish setup.",Modifier.testTag("configuration-warning")) }
        if (c.fixtureMode) Text("Practice data · not connected to the office",style = MaterialTheme.typography.bodyMedium)
        LabeledField("Email",email,{ email = it },"email",enabled = !c.busy,maxLength = 254)
        LabeledField("Password",password,{ password = it },"password",password = true,enabled = !c.busy,maxLength = 1024)
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
        SecondaryButton("Sign out",c::signOut,enabled = !c.busy)
    }
}
@Composable private fun PrinterScreen(c: VanController) {
    val context = LocalContext.current
    val printer = remember { PrinterRegistry.select(context) }
    val scanner = remember { SenraiseScanner(context) }
    DisposableEffect(printer,scanner) { onDispose { scanner.close(); printer.close() } }
    ScreenFrame("Settings",c::back,action = "Done",onAction = c::back,actionTag = "printer-done",scroll = false) {
        PrinterTestScreen(printer,scanner,Modifier.fillMaxSize())
    }
}
