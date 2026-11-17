package com.sunpride.field.sell

import android.content.Context
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.field.sell.auth.SellAccess
import com.sunpride.field.sell.data.VanRepository
import com.sunpride.field.sell.printing.PrinterTestScreen
import com.sunpride.field.sell.scanning.LocalScannerInput
import com.sunpride.field.sell.scanning.ScannerInput
import com.sunpride.field.sell.ui.*

/**
 * SP-0192: everything the Sell area holds while it is switched on: the selling store and its sender, the screen
 * controller, the one printer and the one scanner. Built only for a person whose Selling is on (never at start-up for
 * anyone else), and closed when Selling goes off or the person signs out.
 */
class SellHost private constructor(val repository: VanRepository, val controller: VanController,
    val printer: com.sunpride.field.sell.printing.ReceiptPrinter, val scanner: ScannerInput) : AutoCloseable {
    override fun close() {
        runCatching { repository.close() }
        runCatching { printer.close() }
        runCatching { scanner.close() }
    }
    companion object {
        /** The live host on the Field session ([stub] = DEBUG practice data, never the office). */
        fun create(context: Context, access: SellAccess, stub: Boolean = false,
            printer: com.sunpride.field.sell.printing.ReceiptPrinter? = null, scanner: ScannerInput? = null): SellHost {
            val app = context.applicationContext
            val repository = VanRepository.create(app, access, stub)
            // VAN-017: one printer for the Sell area's lifetime: the H10's built-in printer, a chosen Bluetooth one, or none.
            val selected = printer ?: com.sunpride.field.sell.printing.PrinterRegistry.select(app)
            val controller = VanController(repository, AppEnvironment(access.siteUrl), fixtureMode = stub, printer = selected,
                features = VanFeatures.forBuild(com.sunpride.field.BuildConfig.DEBUG, ""))
            return SellHost(repository, controller, selected, scanner ?: ScannerInput(app))
        }
        /** The Activity forwards keys here while a Sell host exists (keyboard-wedge scans on the selling grid only). */
        @Volatile var active: SellHost? = null
    }
}

/**
 * Keeps the host's controller running for as long as Selling is on (so a sale in progress survives a visit to another tab).
 * Put once in the Field app's signed-in shell; [content] is not drawn here.
 */
@Composable fun SellRuntime(host: SellHost) {
    LaunchedEffect(host) { host.controller.run(true) }
    val appContext = androidx.compose.ui.platform.LocalContext.current.applicationContext
    // IP-HH2: wrong-PIN counts (supervisor, crew) survive closing the app.
    LaunchedEffect(host) { host.controller.installLockout(com.sunpride.field.sell.security.PinLockout(com.sunpride.field.sell.security.PrefsLockoutStorage(appContext))) }
    DisposableEffect(host) { SellHost.active = host; onDispose { if (SellHost.active === host) SellHost.active = null } }
}

/** The Sell tab: the Van app's selling screens, in their owner-chosen look, with the scanner on only while it shows. */
@Composable fun SellArea(host: SellHost, onLeave: () -> Unit, modifier: Modifier = Modifier) {
    val c = host.controller
    val scanner = host.scanner
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(scanner, lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_START) scanner.start() else if (event == Lifecycle.Event.ON_STOP) scanner.stop() }
        lifecycle.addObserver(observer)
        if (lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) scanner.start()
        onDispose { lifecycle.removeObserver(observer); scanner.stop() }
    }
    val offline = com.sunpride.field.ui.syncstatus.rememberOffline()
    CompositionLocalProvider(LocalScannerInput provides scanner, LocalSellOffline provides offline) {
        MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) {
            // Back inside the Sell area steps back to its Trip page; Back on the Trip page leaves for the Field app's Today.
            BackHandler(c.page != Page.HOME) { c.back() }
            BackHandler(c.page == Page.HOME) { onLeave() }
            androidx.compose.foundation.layout.Box(modifier.fillMaxSize().then(Modifier.testTag("sell-area"))) {
                when {
                    !c.initialized -> ScreenFrame("Sell") { Text("Getting your day ready…") }
                    else -> SellShell(c) { SellContent(c) }
                }
            }
            // IP-P0: asked after every print, on whichever screen the seller is on.
            c.printQuestionSaleId?.let { DidItPrintSheet(c) }
        }
    }
}

@Composable private fun SellContent(c: VanController) {
    when (c.page) {
        Page.MORE -> MoreScreen(c)
        Page.HOME -> HomeScreen(c)
        Page.ROUTE_OPS -> RouteOpsScreen(c)
        Page.ACCEPT_LOAD -> AcceptLoadScreen(c)
        Page.LOAD -> CheckLoadScreen(c)
        Page.START -> StartTripScreen(c)
        Page.STOCK -> TruckStockScreen(c)
        Page.STOCK_COUNT -> StockCountScreen(c)
        Page.CUSTOMERS -> CustomersScreen(c)
        Page.WALK_IN -> WalkInScreen(c)
        Page.CUSTOMER -> CustomerDetailScreen(c)
        Page.PRINTER -> SellPrinterScreen(c)
        Page.CATALOGUE -> VanCatalogue(c)
        Page.PRODUCTS -> ProductSearchScreen(c)
        Page.SALE -> SaleScreen(c)
        Page.CHECKOUT -> CheckoutScreen(c)
        Page.SALE_DONE -> SaleDoneScreen(c)
        Page.RETURN -> ReturnScreen(c)
        Page.RETURN_DONE -> ReturnDoneScreen(c)
        Page.RECEIPTS -> ReceiptsScreen(c)
        Page.CASH -> CashCountScreen(c)
        Page.CLOSE_TRIP -> CloseTripScreen(c)
        Page.SYNC -> SyncHealthScreen(c)
        Page.LOCATION_CONSENT -> LocationConsentScreen(c)
    }
}

@Composable private fun SellPrinterScreen(c: VanController) {
    // VAN-017: the shared printer (also used for sale receipts); the host owns and closes it. The scanner is the Sell area's one.
    val scanner = checkNotNull(LocalScannerInput.current)
    ScreenFrame("Printer & scanner", c::back, action = "Done", onAction = c::back, actionTag = "printer-done", scroll = false) {
        PrinterTestScreen(c.printer, scanner, Modifier.fillMaxSize(), lastPrint = c.lastPrint?.let { last ->
            java.time.Instant.ofEpochMilli(last.at).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("h:mm a")) + " · " + last.text
        })
    }
}
