package com.sunpride.van.ui

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.sunpride.van.AppEnvironment
import com.sunpride.van.VanFeature
import com.sunpride.van.VanFeatures
import androidx.lifecycle.Lifecycle
import com.sunpride.van.data.*
import com.sunpride.van.device.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*

/** All data/actions use the encrypted DEBUG repository, never the shared DEV server. */
class VanUiDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val repositories = mutableListOf<VanRepository>()
    private data class Host(val controller: VanController, val restore: Boolean)
    private var host by mutableStateOf<Host?>(null)
    private val c get() = host!!.controller
    @Before fun resetFixture() {
        WorkManager.getInstance(context).cancelUniqueWork("van-sales-sync-stub").result.get()
        context.deleteDatabase("van_stub_store.db")
        context.getSharedPreferences("van_fixture_backend",0).edit().clear().commit()
        rule.runOnUiThread { rule.activity.applySystemBars(false) }
    }
    @After fun closeRepositories() {
        rule.runOnUiThread { host = null }
        rule.waitForIdle()
        repositories.forEach { it.close() }
    }
    private fun newController(mode: String = "ready", fixtureMode: Boolean = true,
        printer: com.sunpride.van.printing.ReceiptPrinter = com.sunpride.van.printing.NoPrinter(),
        features: VanFeatures = VanFeatures.ALL): VanController {
        val repo = if (mode == "ready") VanRepository.forWorker(context,true) else VanRepository.create(context,stubMode = mode)
        repositories += repo
        return VanController(repo,AppEnvironment("",""),fixtureMode,printer = printer,features = features) {
            withContext(Dispatchers.IO) { hex(sha256(KeystoreDeviceKey.loadOrCreate(context,"sunpride-van-stub-device-p256-v1").publicKeySpki)).uppercase().chunked(4).joinToString(" ") }
        }
    }
    private fun mount(restore: Boolean = true, fixtureMode: Boolean = true,
        printer: com.sunpride.van.printing.ReceiptPrinter = com.sunpride.van.printing.NoPrinter(),
        features: VanFeatures = VanFeatures.ALL) {
        host = Host(newController(fixtureMode = fixtureMode,printer = printer,features = features),restore)
        rule.setContent { host?.let { VanApp(it.controller,restore = it.restore) } }
        if (restore) ready() else rule.waitUntil(10_000) { c.initialized }
    }
    private fun ready() { rule.waitUntil(20_000) { c.initialized && !c.busy && c.trip != null && c.products.size == 2 && c.policy != null } }
    private fun open(page: Page) { rule.runOnUiThread { c.open(page) }; rule.waitForIdle() }
    private fun hideKeyboard() { runCatching { Espresso.closeSoftKeyboard() }; rule.waitForIdle() }
    private fun sync() { runBlocking { c.repository.syncNow() }; rule.waitForIdle() }
    private fun loadAndStart() {
        open(Page.LOAD)
        rule.onNodeWithTag("confirm-load").performClick()
        rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
        sync(); rule.waitUntil(10_000) { c.trip?.status == "loaded" }
        open(Page.START)
        rule.onNodeWithTag("confirm-truck").performClick()
        rule.onNodeWithTag("confirm-route").performClick()
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy }
        sync(); rule.waitUntil(10_000) { c.trip?.status == "active" }
    }
    @Test fun signInWithPracticeInputsReachesAssignedTrip() {
        mount(restore = false)
        rule.onNodeWithTag("sign-in").assertIsNotEnabled()
        rule.onNodeWithTag("email").performTextInput("seller@fixture.invalid")
        // Fixture-only input: never sent to a server, never persisted by the UI.
        rule.onNodeWithTag("password").performTextInput("practice")
        hideKeyboard()
        rule.onNodeWithTag("sign-in").assertIsEnabled().performClick()
        ready()
        rule.onNodeWithTag("trip-number").assertTextEquals("TRIP-20261007-V014-1")
    }
    // SP-0130: a wrong password or no connection reads as plain words, and the seller stays on Sign in.
    @Test fun wrongPasswordAndOfflineShowPlainSignInMessages() {
        mount(restore = false)
        fun attempt(password: String, expected: String) {
            rule.onNodeWithTag("email").performTextClearance()
            rule.onNodeWithTag("email").performTextInput("seller@fixture.invalid")
            rule.onNodeWithTag("password").performTextInput(password)
            hideKeyboard()
            rule.onNodeWithTag("sign-in").performClick()
            rule.waitUntil(10_000) { !c.busy && c.message == expected }
            rule.onNodeWithTag("message").assertTextEquals(expected)
            assertFalse(c.session.signedIn)
            rule.onNodeWithTag("sign-in").assertExists()
        }
        attempt(VanRepository.STUB_WRONG_PASSWORD,"Incorrect email or password.")
        captureVanScreenshot(rule,"sp-0130-wrong-password","sign-in")
        attempt(VanRepository.STUB_OFFLINE_PASSWORD,"You're offline. Check your connection and try again.")
        // The right password still signs in afterwards.
        rule.onNodeWithTag("password").performTextInput("practice"); hideKeyboard()
        rule.onNodeWithTag("sign-in").performClick()
        ready()
    }
    @Test fun homeRendersFixtureAndSafePrimaryBounds() {
        mount()
        rule.onNodeWithTag("trip-number").assertTextEquals("TRIP-20261007-V014-1")
        rule.onNodeWithTag("trip-status").assertTextEquals("Loading")
        rule.onNodeWithTag("home-primary").assertTextContains("Check the load")
        assertPrimaryClearance(rule,"home-primary")
    }
    @Test fun changedLoadRequiresReasonAndIsDurablyQueued() {
        mount(); open(Page.LOAD)
        rule.onNodeWithTag("minus-1").performClick()
        rule.onNodeWithTag("reason-required-1").assertExists()
        rule.onNodeWithTag("confirm-load").assertIsNotEnabled()
        rule.onNodeWithTag("load-reason-1").performClick()
        rule.onNodeWithTag("load-reason-1-short_loaded").performClick()
        rule.onNodeWithTag("confirm-load").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
        val load = runBlocking { c.repository.load.first { it?.confirmPending == true } }!!
        assertEquals(47L,load.lines.first().pendingActualBase)
        assertEquals("short_loaded",load.lines.first().pendingReason)
        assertTrue(runBlocking { c.repository.syncStatus.first { it.queued > 0 } }.queued > 0)
        sync(); rule.waitUntil(10_000) { c.load?.status == "discrepancy" }
        rule.onNodeWithTag("message").assertTextEquals("Waiting for supervisor approval")
        assertEquals("loading",runBlocking { c.repository.currentTrip.first() }!!.status)
    }
    @Test fun startRequiresLoadedTripAndBothChecks() {
        mount(); open(Page.START)
        rule.onNodeWithTag("start-blocked").assertTextEquals("Confirm the load first")
        rule.onNodeWithTag("confirm-truck").performClick()
        rule.onNodeWithTag("confirm-route").performClick()
        rule.onNodeWithTag("start-trip").assertIsNotEnabled()
        open(Page.LOAD); rule.onNodeWithTag("confirm-load").performClick()
        rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
        sync(); rule.waitUntil(10_000) { c.trip?.status == "loaded" }
        open(Page.START)
        rule.onNodeWithTag("start-trip").assertIsNotEnabled()
        rule.onNodeWithTag("confirm-truck").performClick()
        rule.onNodeWithTag("start-trip").assertIsNotEnabled()
        rule.onNodeWithTag("confirm-route").performClick()
        rule.onNodeWithTag("start-trip").assertIsEnabled()
        assertPrimaryClearance(rule,"start-trip")
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy }
        sync(); rule.waitUntil(10_000) { c.trip?.status == "active" }
        rule.onNodeWithTag("trip-status").assertTextEquals("On route")
    }
    @Test fun damageBeyondStockIsRefusedAndValidDamageUpdatesProjection() {
        mount(); loadAndStart(); open(Page.STOCK)
        rule.onNodeWithTag("damage-0").performClick()
        rule.onNodeWithTag("damage-quantity").performTextInput("49")
        hideKeyboard()
        rule.onNodeWithTag("damage-reason").performClick()
        rule.onNodeWithTag("damage-reason-crushed").performClick()
        rule.onNodeWithTag("save-damage").performClick()
        rule.waitUntil(10_000) { !c.busy && c.message == "Not enough stock on the truck" }
        rule.onNodeWithTag("damage-message").assertTextEquals("Not enough stock on the truck")
        assertEquals(48L,runBlocking { c.repository.truckStock.first() }.first { it.productId == c.products.first().productId }.availableBase)
        rule.onNodeWithTag("damage-quantity").performTextReplacement("1"); hideKeyboard()
        rule.onNodeWithTag("save-damage").performClick()
        rule.waitUntil(10_000) { !c.busy && c.stock.any { it.availableBase == 47L && it.damagedBase == 1L } }
        rule.onNodeWithTag("stock-pending").assertTextEquals("Waiting for sync")
        sync()
        val stock = runBlocking { c.repository.truckStock.first() }.first { it.productId == c.products.first().productId }
        assertEquals(47L,stock.availableBase); assertEquals(1L,stock.damagedBase)
    }
    @Test fun walkInRequiresReasonAndAppearsWithSourceLabel() {
        mount(); open(Page.CUSTOMERS)
        rule.onNodeWithTag("add-walk-in").performClick()
        rule.onNodeWithTag("walk-in-name").performTextInput("Corner Store")
        rule.onNodeWithTag("save-walk-in").assertIsNotEnabled()
        rule.onNodeWithTag("walk-in-reason").performTextInput("Customer asked at the truck")
        hideKeyboard(); rule.onNodeWithTag("save-walk-in").performClick()
        rule.waitUntil(10_000) { !c.busy && c.customers.any { it.name == "Corner Store" && it.source == "walk_in" } }
        rule.onNodeWithTag("customer-walk_in-0").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("customer-walk_in-0").assert(hasAnyDescendant(hasText("Walk-in")))
        assertTrue(runBlocking { c.repository.customers.first() }.single { it.name == "Corner Store" }.localOnly)
    }
    @Test fun productSearchFindsByNameCodeAndBarcodeWithStockAndPrice() {
        mount(); loadAndStart()
        open(Page.HOME)
        rule.onNodeWithTag("open-products").performScrollTo().performClick()
        rule.onNodeWithTag("screen-title").assertTextEquals("Find product")
        rule.onNodeWithTag("product-count").assertTextContains("2 products",substring = true)
        // Products on the truck come first; prices come from the governed bootstrap snapshot.
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        rule.waitUntil(10_000) { c.stock.any { it.productId == juice.productId && it.availableBase > 0 } && c.prices.size == 2 }
        val onTruck = c.stock.single { it.productId == juice.productId }.availableBase
        rule.onNodeWithTag("product-price-0",useUnmergedTree = true).assertTextEquals("₱42.75 / PC")
        captureVanScreenshot(rule,"24-find-product","product-search")
        rule.onNodeWithTag("product-search").performTextInput("chunks")
        rule.onNodeWithTag("product-count").assertTextEquals("1 match")
        rule.onNodeWithTag("product-0").assertTextContains("Pineapple Chunks 432g",substring = true)
        rule.onNodeWithTag("product-price-0",useUnmergedTree = true).assertTextEquals("₱42.75 / PC")
        rule.onNodeWithTag("product-clear").performClick()
        rule.onNodeWithTag("product-search").performTextInput("sppj1l")
        rule.onNodeWithTag("product-0").assertTextContains("Pineapple Juice 1L",substring = true)
        rule.onNodeWithTag("product-available-0",useUnmergedTree = true).assertTextEquals("${juice.displayQuantity(onTruck)} PC")
        rule.onNodeWithTag("product-price-0",useUnmergedTree = true).assertTextEquals("₱68.50 / PC")
        captureVanScreenshot(rule,"25-find-product-match","product-search")
        // A hardware scan (vendor broadcast) replaces the query with the exact barcode match.
        context.sendBroadcast(android.content.Intent(com.sunpride.van.scanning.SenraiseScanner.ACTION).putExtra(com.sunpride.van.scanning.SenraiseScanner.RESULT_EXTRA,"4800000000017").setPackage(context.packageName))
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("product-count").fetchSemanticsNodes().isNotEmpty() && runCatching { rule.onNodeWithTag("product-search").assertTextContains("4800000000017",substring = true) }.isSuccess }
        rule.onNodeWithTag("product-count").assertTextEquals("1 match")
        rule.onNodeWithTag("product-0").assertTextContains("Pineapple Juice 1L",substring = true)
        rule.onNodeWithTag("scan-unit",useUnmergedTree = true).assertTextEquals("PC")
        context.sendBroadcast(android.content.Intent(com.sunpride.van.scanning.SenraiseScanner.ACTION).putExtra(com.sunpride.van.scanning.SenraiseScanner.RESULT_EXTRA,"0000000000000").setPackage(context.packageName))
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("scan-message",useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("scan-message",useUnmergedTree = true).assertTextEquals("No product on this phone has barcode 0000000000000.")
        rule.onNodeWithTag("product-count").assertTextEquals("No product with this barcode")
        rule.onAllNodesWithTag("product-0").assertCountEquals(0)
    }
    @Test fun scanningResolvesUnitsFromVendorIntentsAndHandlesNotFoundAndCamera() {
        mount(); loadAndStart()
        open(Page.PRODUCTS)
        rule.onNodeWithTag("screen-title").assertTextEquals("Find product")
        fun broadcast(action: String, extra: String, code: String) =
            context.sendBroadcast(android.content.Intent(action).putExtra(extra,code).setPackage(context.packageName))
        // A case barcode (another vendor's documented intent) resolves to the product AND the case unit.
        broadcast("com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED","data","14800000000016")
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("scan-found").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("scan-unit",useUnmergedTree = true).assertTextEquals("CS · 24 PC")
        rule.onNodeWithTag("product-0").assertTextContains("Pineapple Juice 1L",substring = true)
        captureVanScreenshot(rule,"26-scan-case","product-search")
        // The configurable action (Zebra DataWedge / Honeywell) and its default extra.
        broadcast(com.sunpride.van.scanning.ScanIntentProfiles.SUNPRIDE_ACTION,"com.symbol.datawedge.data_string","04800000000017")
        rule.waitUntil(5_000) { runCatching { rule.onNodeWithTag("scan-unit",useUnmergedTree = true).assertTextEquals("PC") }.isSuccess }
        // Not found: clear message and two ways forward.
        broadcast(com.sunpride.van.scanning.SenraiseScanner.ACTION,com.sunpride.van.scanning.SenraiseScanner.RESULT_EXTRA,"9999999999994")
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("scan-not-found").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("scan-search-name").assertIsDisplayed()
        rule.onNodeWithTag("scan-camera").assertIsDisplayed()
        captureVanScreenshot(rule,"27-scan-not-found","product-search")
        rule.onNodeWithTag("scan-search-name").performClick()
        rule.onAllNodesWithTag("scan-not-found").assertCountEquals(0)
        rule.onNodeWithTag("product-count").assertTextContains("2 products",substring = true)
        hideKeyboard()
        // Camera: permission granted through UiAutomation (no system dialog), page opens and Back returns.
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName,android.Manifest.permission.CAMERA)
        rule.onNodeWithTag("product-camera").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("camera-title").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("camera-close").assertTextEquals("Back to Find product")
        assertPrimaryClearance(rule,"camera-close")
        captureVanScreenshot(rule,"28-scan-camera","camera-close")
        rule.onNodeWithTag("camera-close").performClick()
        rule.onNodeWithTag("screen-title").assertTextEquals("Find product")
        assertPrimaryClearance(rule,"product-camera")
    }
    @Test fun printerAndScannerScreenRendersRealServiceControls() {
        // VAN-017: the real registry printer (the H10P service) for the check; nothing is printed here.
        val printer = com.sunpride.van.printing.PrinterRegistry.select(context)
        try {
            mount(printer = printer); open(Page.PRINTER)
            rule.onNodeWithText("Printer & scanner").assertIsDisplayed()
            rule.onNodeWithText("Print test receipt").assertExists()
            rule.onNodeWithText("Scan with camera").assertExists()
            rule.waitUntil(10_000) { rule.onAllNodesWithText("Connection: Connected",substring = true).fetchSemanticsNodes().isNotEmpty() }
            // The H10P service has no paper query; the check says so instead of claiming paper is loaded.
            rule.onNodeWithTag("printer-paper").assertTextContains("Paper: Not reported by this printer",substring = true)
            rule.onNodeWithTag("printer-last").assertTextEquals("Last receipt: None printed yet")
            // VAN-015: no Bluetooth printer chosen, so the built-in printer stays in use.
            rule.onNodeWithTag("printer-in-use").assertTextEquals("This handheld's built-in printer")
            rule.onNodeWithTag("choose-bluetooth-printer").assertExists()
            rule.onNodeWithTag("check-printer").performClick()
            rule.waitUntil(10_000) { rule.onAllNodesWithText("Check printer").fetchSemanticsNodes().isNotEmpty() }
            captureVanScreenshot(rule,"24-printer-check","printer-done")
            // The existing printer device suite, not this UI smoke test, prints the real receipt.
        } finally { rule.runOnUiThread { host = null }; rule.waitForIdle(); printer.close() }
    }
    @Test fun voidDialogRequiresSupervisorCodeClearsItOnReasonChangeAndPrintsOnlyVoidSlips() {
        val printer = com.sunpride.van.printing.FakeReceiptPrinter()
        mount(printer = printer); loadAndStart()
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        testPriceFeed(juice.productId)
        val receipt = runBlocking {
            c.repository.completeSale(com.sunpride.van.pos.CheckoutRequest(java.util.UUID.randomUUID().toString(),c.customers.first { it.source == "route" }.outletId,
                listOf(com.sunpride.van.pos.CartLine(juice.productId,1)),com.sunpride.van.pos.PaymentInput("cash",10000)),8500)
        }
        open(Page.RECEIPTS)
        rule.waitUntil(10000) { c.savedSales.size == 1 }
        rule.onNodeWithTag("receipt-0-print").performScrollTo().performClick()
        rule.waitUntil(10000) { !c.printing && c.savedSales.single().printed && printer.documents.size == 1 }
        rule.onNodeWithTag("receipt-0-void-sale").performScrollTo().performClick()
        rule.onNodeWithTag("confirm-void").assertIsNotEnabled()
        rule.onNodeWithTag("void-reason-wrong_items").performScrollTo().performClick()
        val p = c.policy!!; val trip = c.trip!!.tripId
        val firstCode = com.sunpride.van.pos.VoidApprovalCodes.code(p.voidApproval!!.key!!,trip,receipt.receiptNumber,receipt.totalMinor,"wrong_items")
        rule.onNodeWithTag("void-code").performScrollTo().performTextInput(firstCode); hideKeyboard()
        rule.onNodeWithTag("confirm-void").assertIsEnabled()
        rule.onNodeWithTag("void-reason-other").performScrollTo().performClick()
        rule.onNodeWithTag("confirm-void").assertIsNotEnabled()
        rule.onNodeWithTag("void-note").performScrollTo().performTextInput("Customer changed the order"); hideKeyboard()
        rule.onNodeWithTag("confirm-void").assertIsNotEnabled() // selecting Other discarded the old code.
        val code = com.sunpride.van.pos.VoidApprovalCodes.code(p.voidApproval.key!!,trip,receipt.receiptNumber,receipt.totalMinor,"other")
        // A wrong code is refused, nothing is voided, and the dialog stays open with what was typed.
        val wrong = if (code == "00000000") "11111111" else "00000000"
        rule.onNodeWithTag("void-code").performScrollTo().performTextInput(wrong); hideKeyboard()
        rule.onNodeWithTag("confirm-void").assertIsEnabled().performClick()
        rule.waitUntil(10000) { !c.busy }
        rule.onNodeWithTag("void-error").assertExists()
        assertTrue(c.savedSales.single().void == null)
        rule.onNodeWithTag("void-code").performScrollTo().performTextClearance()
        rule.onNodeWithTag("void-code").performTextInput(code); hideKeyboard()
        assertPrimaryClearance(rule,"confirm-void")
        rule.onNodeWithTag("confirm-void").assertIsEnabled().performClick()
        rule.waitUntil(10000) { !c.busy && !c.printing && c.savedSales.single().voidSlipPrinted && printer.documents.size == 2 }
        rule.onNodeWithTag("receipt-0-void").performScrollTo().assertTextEquals("VOIDED · Other (explain)")
        rule.onNodeWithTag("receipt-0-void-sale").assertDoesNotExist()
        rule.onNodeWithTag("receipt-0-reprint").performScrollTo().assertTextEquals("Reprint void slip").performClick()
        rule.waitUntil(10000) { !c.printing && printer.documents.size == 3 }
        assertFalse(printer.documents[1].isReprint); assertFalse(printer.documents[2].isReprint)
        assertTrue(printer.documents.drop(1).all { doc -> doc.elements.filterIsInstance<com.sunpride.van.printing.ReceiptElement.Text>().any { it.text == "VOID - SALE CANCELLED" } })
        assertTrue(runBlocking { c.repository.fixtureStore().saleStockIssues() }.isEmpty())
    }
    @Test fun saleReceiptPrintsOnceThenReprintsOnlyWithAReasonAndMarker() {
        val printer = com.sunpride.van.printing.FakeReceiptPrinter()
        mount(printer = printer); loadAndStart()
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        rule.waitUntil(10_000) { c.stock.any { it.productId == juice.productId && it.availableBase > 2 } }
        testPriceFeed(juice.productId)
        open(Page.HOME)
        rule.onNodeWithTag("new-sale").performScrollTo().performClick()
        rule.onNodeWithTag("customer-route-1").performClick()
        rule.onNodeWithTag("start-sale").performClick()
        rule.onNodeWithTag("sale-add-product").performScrollTo().performClick()
        rule.onNodeWithTag("product-search").performTextInput("sppj1l"); hideKeyboard()
        rule.onNodeWithTag("product-0").performClick()
        rule.onNodeWithTag("sale-quantity").performTextInput("1"); hideKeyboard()
        rule.onNodeWithTag("save-quantity").performClick()
        rule.waitUntil(5_000) { c.page == Page.SALE }
        rule.onNodeWithTag("checkout").performClick()
        rule.onNodeWithTag("cash-received").performTextInput("100"); hideKeyboard()
        rule.onNodeWithTag("complete-sale").assertIsEnabled().performClick()
        // Saved first, then the original prints automatically, once.
        rule.waitUntil(10_000) { c.page == Page.SALE_DONE && !c.printing && printer.documents.size == 1 && c.savedSales.isNotEmpty() }
        assertFalse(printer.documents.single().isReprint)
        rule.onNodeWithTag("print-status",useUnmergedTree = true).performScrollTo().assertTextEquals("Receipt printed. Tear it off for the customer.")
        captureVanScreenshot(rule,"33-sale-printed","sale-done")
        rule.onNodeWithTag("sale-reprint").performScrollTo().performClick()
        rule.onNodeWithTag("confirm-reprint").assertIsNotEnabled()
        rule.onNodeWithTag("reprint-reason-customer_copy").performClick()
        rule.onNodeWithTag("confirm-reprint").assertTextEquals("Print copy 1").assertIsEnabled()
        captureVanScreenshot(rule,"34-reprint-reason","confirm-reprint")
        rule.onNodeWithTag("confirm-reprint").performClick()
        rule.waitUntil(10_000) { !c.printing && printer.documents.size == 2 }
        assertTrue(printer.documents[1].isReprint)
        val lines = com.sunpride.van.printing.ReceiptLayoutFormatter().format(printer.documents[1])
            .filterIsInstance<com.sunpride.van.printing.ReceiptCommand.Line>().map { it.text }
        assertEquals("REPRINT",lines.first()); assertTrue(lines.joinToString("").contains("Reason: Customer needs another copy"))
        rule.onNodeWithTag("print-status",useUnmergedTree = true).assertTextEquals("Reprint copy 1 printed. It is marked REPRINT.")
        // The sale itself is unchanged: one saved sale, stock deducted once.
        assertEquals(1,c.sync.savedSales)
        rule.onNodeWithTag("sale-done").performClick()
        rule.onNodeWithTag("open-receipts").performScrollTo().performClick()
        rule.waitUntil(10_000) { c.savedSales.size == 1 }
        rule.onNodeWithTag("receipt-0-state",useUnmergedTree = true).assertTextEquals("Printed · reprinted 1× · 2 reprints left")
        captureVanScreenshot(rule,"35-receipts")
        // Printer reports no paper: refused before anything is recorded or printed.
        printer.paper = com.sunpride.van.printing.PaperState.OUT
        rule.onNodeWithTag("receipt-0-reprint").performClick()
        rule.onNodeWithTag("reprint-reason-unreadable").performClick()
        rule.onNodeWithTag("confirm-reprint").performClick()
        rule.waitUntil(10_000) { !c.printing && c.printMessage == "The printer is out of paper. Load paper, then print again." }
        assertEquals(2,printer.documents.size)
        rule.onNodeWithTag("receipt-0-state",useUnmergedTree = true).assertTextEquals("Printed · reprinted 1× · 2 reprints left")
    }
    // SP-0125 password eye: hidden by default, accessible label, re-hidden when the app is left or the form is sent.
    @Test fun passwordEyeShowsAndHidesAndReHidesWhenTheAppIsLeft() {
        mount(restore = false)
        // What the field actually draws (the password transformation applies to the layout, not EditableText).
        val hidden = SemanticsMatcher("password drawn as dots") { node ->
            val layouts = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            node.config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action!!(layouts)
            layouts.first().layoutInput.text.text.let { it.isNotEmpty() && it.none { ch -> ch.isLetterOrDigit() } }
        }
        rule.onNodeWithTag("sign-in-logo").assertIsDisplayed()
        rule.onNodeWithTag("password").performTextInput("practice")
        rule.onNodeWithTag("password").assert(hidden)
        rule.onNodeWithContentDescription("Show password").assertIsDisplayed().performClick()
        rule.onNodeWithTag("password").assert(!hidden)
        rule.onNodeWithTag("password").assertTextContains("practice")
        rule.onNodeWithContentDescription("Hide password").assertIsDisplayed()
        // Leaving the app (Home, Recents, screen off) stops the activity: the password is hidden again.
        rule.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        rule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        rule.waitForIdle()
        rule.onNodeWithTag("password").assert(hidden)
        rule.onNodeWithContentDescription("Show password").assertIsDisplayed()
        // Shown again, then sent: the field clears and goes back to hidden.
        rule.onNodeWithContentDescription("Show password").performClick()
        rule.onNodeWithTag("email").performTextInput("seller@fixture.invalid"); hideKeyboard()
        rule.onNodeWithTag("sign-in").performClick()
        ready()
        rule.runOnUiThread { c.signOut() }
        rule.waitUntil(10_000) { !c.busy && !c.session.signedIn }
        // Back on Sign in: a new password starts hidden.
        rule.onNodeWithTag("password").performTextInput("again")
        rule.onNodeWithTag("password").assert(hidden)
        rule.onNodeWithContentDescription("Show password").assertIsDisplayed()
    }
    @Test fun betaBuildKeepsSellingHidesDeveloperToolsAndShowsReportAnIssue() {
        mount(features = VanFeatures.forBuild(debug = false,webUrl = "https://beta.sunpride.example"))
        assertFalse(VanFeature.DEVELOPER_TOOLS in c.features)
        rule.onNodeWithTag("new-sale").performScrollTo().assertExists()
        rule.onNodeWithTag("report-issue").performScrollTo().assertIsDisplayed()
        captureVanScreenshot(rule,"40-beta-home","home-primary")
    }
    @Test fun devBuildHidesReportWithoutWebUrl() {
        mount()
        rule.onNodeWithTag("new-sale").performScrollTo().assertExists()
        rule.onAllNodesWithTag("report-issue").assertCountEquals(0)
    }
    @Test fun printerTestOpensBeforeSignInAndReturnsToSignIn() {
        mount(restore = false,features = VanFeatures.forBuild(debug = false,webUrl = "https://beta.sunpride.example"))
        rule.onNodeWithTag("report-issue").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("sign-in-printer").performScrollTo().performClick()
        rule.onNodeWithText("Print test receipt").assertExists()
        assertPrimaryClearance(rule,"printer-done")
        rule.onNodeWithTag("printer-done").performClick()
        rule.onNodeWithTag("sign-in").assertExists()
    }
    /** Swaps the practice backend's price feed for a test-only one: ₱85.00 per PC for the juice, every other product unpriced. */
    private fun testPriceFeed(juice: String) {
        runBlocking { c.repository.fixtureStore().let { st ->
            st.db.rows().clearPriceListLine(st.scope.fullAuthSubject,st.scope.deviceId)
            st.db.rows().insertPriceListLine(com.sunpride.van.storage.PriceListLineRow(
                st.scope.fullAuthSubject,st.scope.deviceId,"PL-PRACTICE",juice,"PC",8_500,"PHP",System.currentTimeMillis()-60_000,null))
        } }
        rule.waitUntil(10_000) { c.prices.map { it.priceListId to it.productId } == listOf("PL-PRACTICE" to juice) }
    }
    @Test fun checkoutValidatesPricesAndCashThenSavesTheSaleOnThisPhone() {
        mount(); loadAndStart()
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        rule.waitUntil(10_000) { c.stock.any { it.productId == juice.productId && it.availableBase > 2 } }
        val before = c.stock.single { it.productId == juice.productId }.availableBase
        testPriceFeed(juice.productId)
        rule.waitUntil(10_000) { c.prices.isNotEmpty() }
        open(Page.HOME)
        rule.onNodeWithTag("new-sale").performScrollTo().performClick()
        rule.onNodeWithTag("customer-route-0").performClick()
        rule.onNodeWithTag("start-sale").assertIsEnabled().performClick()
        rule.onNodeWithTag("sale-customer").assertTextEquals("Aling Nena Store")
        rule.onNodeWithTag("checkout").assertIsNotEnabled()
        fun add(query: String, quantity: String) {
            rule.onNodeWithTag("sale-add-product").performScrollTo().performClick()
            rule.onNodeWithTag("screen-title").assertTextEquals("Add product")
            rule.onNodeWithTag("product-search").performTextInput(query); hideKeyboard()
            rule.onNodeWithTag("product-0").performClick()
            rule.onNodeWithTag("sale-quantity").performTextInput(quantity); hideKeyboard()
            rule.onNodeWithTag("save-quantity").performClick()
            rule.waitUntil(5_000) { c.page == Page.SALE }
        }
        add("sppj1l","2"); add("chunks","1")
        rule.onNodeWithTag("sale-line-total-0",useUnmergedTree = true).assertTextEquals("₱170.00")
        rule.onNodeWithTag("sale-line-total-1",useUnmergedTree = true).assertTextEquals("Priced by the office")
        captureVanScreenshot(rule,"29-sale-cart","checkout")
        // An unpriced product blocks the sale: no guessed price, Complete stays off.
        rule.onNodeWithTag("checkout").performClick()
        rule.onNodeWithTag("checkout-issue-0").assertTextContains("priced by the office",substring = true)
        rule.onNodeWithTag("complete-sale").assertIsNotEnabled()
        captureVanScreenshot(rule,"30-checkout-unpriced","complete-sale")
        rule.onNodeWithTag("back").performClick()
        rule.onNodeWithTag("sale-line-1").performClick()
        rule.onNodeWithTag("sale-quantity").performTextClearance(); rule.onNodeWithTag("sale-quantity").performTextInput("0"); hideKeyboard()
        rule.onNodeWithTag("save-quantity").assertTextEquals("Remove").performClick()
        rule.onNodeWithTag("checkout").performClick()
        rule.onNodeWithTag("checkout-total",useUnmergedTree = true).assertTextEquals("₱170.00")
        rule.onNodeWithTag("cash-received").performTextInput("150"); hideKeyboard()
        rule.onNodeWithText("Cash received is less than the total.").assertExists()
        rule.onNodeWithTag("complete-sale").assertIsNotEnabled()
        // VAN-012: a reference method needs its number; credit shows the office terms and the due date.
        rule.onNodeWithTag("pay-gcash").performScrollTo().performClick()
        rule.onNodeWithText("Enter the reference number.").assertExists()
        rule.onNodeWithTag("complete-sale").assertIsNotEnabled()
        rule.onNodeWithTag("pay-credit").performScrollTo().performClick()
        rule.onNodeWithTag("credit-terms",useUnmergedTree = true).assertTextEquals("Terms 30 days · Credit left ₱5,000.00")
        rule.onNodeWithTag("credit-due",useUnmergedTree = true).assertTextEquals("Due 2026-11-06")
        captureVanScreenshot(rule,"31a-checkout-credit","complete-sale")
        rule.onNodeWithTag("pay-cash").performScrollTo().performClick()
        rule.onNodeWithTag("cash-received").performTextClearance(); rule.onNodeWithTag("cash-received").performTextInput("200"); hideKeyboard()
        rule.onNodeWithTag("checkout-change",useUnmergedTree = true).assertTextEquals("Change ₱30.00")
        captureVanScreenshot(rule,"31-checkout-cash","complete-sale")
        rule.onNodeWithTag("complete-sale").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.page == Page.SALE_DONE && !c.busy }
        rule.onNodeWithTag("receipt-number",useUnmergedTree = true).assertTextContains("TRIP-20261007-V014-1-",substring = true)
        rule.onNodeWithTag("receipt-total",useUnmergedTree = true).assertTextEquals("₱170.00")
        rule.onNodeWithTag("receipt-payment-state",useUnmergedTree = true).assertTextEquals("Paid")
        captureVanScreenshot(rule,"32-sale-saved","sale-done")
        // Saved and deducted on the phone without any network call; parked, not queued for the gateway.
        rule.waitUntil(10_000) { c.sync.savedSales == 1 && c.stock.single { it.productId == juice.productId }.availableBase == before-2 }
        assertEquals(0,c.sync.queued); assertNull(c.sale)
        rule.onNodeWithTag("sale-done").performClick()
        rule.onNodeWithTag("sync-line").assertTextContains("1 sale saved on this phone",substring = true)
    }
    @Test fun customerReturnCapturesUnitBatchReasonAndDispositionAndHoldsStockForApproval() {
        mount(); loadAndStart()
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        rule.waitUntil(10_000) { c.stock.any { it.productId == juice.productId } }
        val damagedBefore = c.stock.single { it.productId == juice.productId }.damagedBase
        val availableBefore = c.stock.single { it.productId == juice.productId }.availableBase
        open(Page.CUSTOMERS)
        rule.onNodeWithTag("customer-route-0").performClick()
        rule.onNodeWithTag("start-return").assertIsEnabled().performClick()
        rule.waitUntil(5_000) { c.page == Page.RETURN && c.returnFacts != null }
        rule.onNodeWithTag("save-return").assertIsNotEnabled()
        rule.onNodeWithTag("return-add-product").performScrollTo().performClick()
        // The case barcode picks the product counted in cases.
        rule.onNodeWithTag("return-product-search").performTextInput("14800000000016"); hideKeyboard()
        rule.onNodeWithTag("return-pick-0").performClick()
        rule.onNodeWithTag("return-unit-CS").assertIsSelected()
        rule.onNodeWithTag("return-quantity").performTextInput("1"); hideKeyboard()
        rule.onNodeWithTag("return-reason-expired").performScrollTo().performClick()
        rule.onNodeWithTag("return-line-add").assertIsNotEnabled()
        rule.onNodeWithTag("return-disposition-bad_stock").performScrollTo().performClick()
        rule.onNodeWithText("${juice.name}: enter the batch or lot number printed on the pack.").assertExists()
        rule.onNodeWithTag("return-lot").performScrollTo().performTextInput("lot-2026-09"); hideKeyboard()
        rule.onNodeWithTag("return-expiry").performScrollTo().performTextInput("2026-09-30"); hideKeyboard()
        captureVanScreenshot(rule,"40-return-line","return-line-add")
        rule.onNodeWithTag("return-line-add").assertIsEnabled().performClick()
        rule.onNodeWithTag("return-effect-0",useUnmergedTree = true).assertTextEquals("Held on the truck with damaged stock until approved")
        rule.onNodeWithTag("return-approval").performScrollTo().assertTextContains("Not bought on a receipt from this phone",substring = true)
        captureVanScreenshot(rule,"41-return","save-return")
        rule.onNodeWithTag("save-return").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.page == Page.RETURN_DONE && !c.busy }
        rule.onNodeWithTag("return-number",useUnmergedTree = true).assertTextContains("TRIP-20261007-V014-1-",substring = true)
        rule.onNodeWithTag("return-status").assertTextContains("Not bought on a receipt from this phone",substring = true)
        captureVanScreenshot(rule,"42-return-saved","return-done")
        // One case = 24 PC into damaged stock (held), none into sellable stock; parked, not queued.
        rule.waitUntil(10_000) { c.sync.savedReturns == 1 && c.stock.single { it.productId == juice.productId }.damagedBase == damagedBefore+24 }
        assertEquals(availableBefore,c.stock.single { it.productId == juice.productId }.availableBase)
        assertEquals(0,c.sync.queued); assertNull(c.returnDraft)
        rule.onNodeWithTag("return-done").performClick()
        rule.onNodeWithTag("sync-line").assertTextContains("1 return saved on this phone",substring = true)
    }
    @Test fun checkPaymentKeepsItsReferenceAndAwaitsTheOfficeWhileTheSaleIsSaved() {
        mount(); loadAndStart()
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        rule.waitUntil(10_000) { c.stock.any { it.productId == juice.productId && it.availableBase > 2 } }
        testPriceFeed(juice.productId)
        rule.waitUntil(10_000) { c.prices.isNotEmpty() }
        open(Page.HOME)
        rule.onNodeWithTag("new-sale").performScrollTo().performClick()
        rule.onNodeWithTag("customer-route-1").performClick()
        rule.onNodeWithTag("start-sale").assertIsEnabled().performClick()
        rule.onNodeWithTag("sale-add-product").performScrollTo().performClick()
        rule.onNodeWithTag("product-search").performTextInput("sppj1l"); hideKeyboard()
        rule.onNodeWithTag("product-0").performClick()
        rule.onNodeWithTag("sale-quantity").performTextInput("1"); hideKeyboard()
        rule.onNodeWithTag("save-quantity").performClick()
        rule.waitUntil(5_000) { c.page == Page.SALE }
        rule.onNodeWithTag("checkout").performClick()
        // JM Sari-Sari has no credit terms from the office.
        rule.onNodeWithTag("pay-credit").performScrollTo().performClick()
        rule.onNodeWithText("This customer has no credit terms from the office. Take cash or another payment.").assertExists()
        rule.onNodeWithTag("complete-sale").assertIsNotEnabled()
        rule.onNodeWithTag("pay-check").performScrollTo().performClick()
        rule.onNodeWithTag("payment-reference").performScrollTo().performTextInput("bdo 000123"); hideKeyboard()
        rule.onNodeWithTag("payment-amount",useUnmergedTree = true).assertTextContains("₱85.00",substring = true)
        captureVanScreenshot(rule,"31b-checkout-check","complete-sale")
        rule.onNodeWithTag("complete-sale").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.page == Page.SALE_DONE && !c.busy }
        rule.onNodeWithTag("receipt-change",useUnmergedTree = true).assertTextEquals("Check ₱85.00")
        rule.onNodeWithTag("receipt-reference",useUnmergedTree = true).assertTextEquals("Reference BDO 000123")
        rule.onNodeWithTag("receipt-payment-state",useUnmergedTree = true).assertTextEquals("To be confirmed by the office")
        captureVanScreenshot(rule,"32b-sale-saved-check","sale-done")
        assertEquals("awaiting_confirmation",c.lastReceipt!!.paymentStatus)
        rule.waitUntil(10_000) { c.sync.savedSales == 1 }
    }
    @Test fun fullScreenScreenshotTour() {
        mount(restore = false,fixtureMode = false)
        rule.onNodeWithTag("configuration-warning").assertExists()
        captureVanScreenshot(rule,"01-sign-in","sign-in")
        rule.runOnUiThread { host = Host(newController("unregistered"),true) }
        rule.waitUntil(10_000) { c.initialized && !c.busy && c.fingerprint != "Loading…" }
        captureVanScreenshot(rule,"02-enrollment-unregistered","check-again")
        rule.runOnUiThread { host = Host(newController("revoked"),true) }
        rule.waitUntil(10_000) { c.initialized && !c.busy }
        captureVanScreenshot(rule,"03-enrollment-removed","check-again")
        rule.runOnUiThread { host = Host(newController(),true) }; ready()
        captureVanScreenshot(rule,"04-home-loading","home-primary")
        rule.onNodeWithTag("open-printer").performScrollTo()
        captureVanScreenshot(rule,"05-home-actions","home-primary")
        open(Page.LOAD)
        captureVanScreenshot(rule,"06-check-load","confirm-load")
        rule.onNodeWithTag("minus-1").performClick()
        captureVanScreenshot(rule,"07-load-reason-required","confirm-load")
        rule.onNodeWithTag("plus-1").performClick()
        rule.onNodeWithTag("confirm-load").performClick()
        rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
        captureVanScreenshot(rule,"08-load-waiting-sync","confirm-load")
        sync(); rule.waitUntil(10_000) { c.trip?.status == "loaded" }
        captureVanScreenshot(rule,"09-load-loaded","confirm-load")
        open(Page.HOME); captureVanScreenshot(rule,"10-home-loaded","home-primary")
        open(Page.START); captureVanScreenshot(rule,"11-start-trip-unconfirmed","start-trip")
        rule.onNodeWithTag("confirm-truck").performClick(); rule.onNodeWithTag("confirm-route").performClick()
        captureVanScreenshot(rule,"12-start-trip-confirmed","start-trip")
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy }
        sync(); rule.waitUntil(10_000) { c.trip?.status == "active" }
        captureVanScreenshot(rule,"13-home-on-route","home-primary")
        open(Page.STOCK); captureVanScreenshot(rule,"14-truck-stock","stock-sync")
        rule.onNodeWithTag("damage-0").performClick()
        captureVanScreenshot(rule,"15-record-damage","save-damage")
        rule.onNodeWithTag("damage-quantity").performTextInput("49"); hideKeyboard()
        rule.onNodeWithTag("damage-reason").performClick(); rule.onNodeWithTag("damage-reason-crushed").performClick()
        rule.onNodeWithTag("save-damage").performClick()
        rule.waitUntil(10_000) { !c.busy && c.message == "Not enough stock on the truck" }
        captureVanScreenshot(rule,"16-damage-refused","save-damage")
        rule.onNodeWithTag("cancel-damage").performClick()
        open(Page.CUSTOMERS); captureVanScreenshot(rule,"17-customers","add-walk-in")
        rule.onNodeWithTag("add-walk-in").performClick(); captureVanScreenshot(rule,"18-add-walk-in","save-walk-in")
        rule.onNodeWithTag("walk-in-name").performTextInput("Corner Store")
        rule.onNodeWithTag("walk-in-reason").performTextInput("Customer asked at the truck"); hideKeyboard()
        rule.onNodeWithTag("save-walk-in").performClick()
        rule.waitUntil(10_000) { c.page == Page.CUSTOMERS && !c.busy && c.customers.any { it.source == "walk_in" } }
        rule.onNodeWithTag("customer-walk_in-0").performScrollTo()
        captureVanScreenshot(rule,"19-customers-walk-in","add-walk-in")
        rule.onNodeWithTag("customer-walk_in-0").performClick(); captureVanScreenshot(rule,"20-customer-detail","start-sale")
        open(Page.PRINTER); captureVanScreenshot(rule,"21-printer-scanner","printer-done")
        rule.onNodeWithText("Scan with camera").performScrollTo()
        captureVanScreenshot(rule,"23-printer-scanner-controls","printer-done")
        // DEBUG server-only no-trip scenario; use the same strict codec and real sync.
        val empty = JSONObject(context.getSharedPreferences("van_fixture_backend",0).getString("state",FakeVanBackend.FIXTURE)!!).put("trip",JSONObject.NULL).put("load",JSONObject.NULL).put("truckStock",org.json.JSONArray()).put("customers",org.json.JSONArray())
        context.getSharedPreferences("van_fixture_backend",0).edit().putString("state",empty.toString()).putString("replies","{}").commit()
        rule.runOnUiThread { host = Host(newController(),true) }
        rule.waitUntil(10_000) { c.initialized && !c.busy && c.trip == null }
        captureVanScreenshot(rule,"22-no-trip","home-primary")
    }
}
