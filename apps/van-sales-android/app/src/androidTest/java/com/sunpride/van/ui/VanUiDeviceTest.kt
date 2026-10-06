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
    private fun newController(mode: String = "ready", fixtureMode: Boolean = true, features: VanFeatures = VanFeatures.ALL): VanController {
        val repo = if (mode == "ready") VanRepository.forWorker(context,true) else VanRepository.create(context,stubMode = mode)
        repositories += repo
        return VanController(repo,AppEnvironment("",""),fixtureMode,features) {
            withContext(Dispatchers.IO) { hex(sha256(KeystoreDeviceKey.loadOrCreate(context,"sunpride-van-stub-device-p256-v1").publicKeySpki)).uppercase().chunked(4).joinToString(" ") }
        }
    }
    private fun mount(restore: Boolean = true, fixtureMode: Boolean = true, features: VanFeatures = VanFeatures.ALL) {
        host = Host(newController(fixtureMode = fixtureMode,features = features),restore)
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
        // Products on the truck come first; no governed price feed yet, so no guessed price.
        val juice = c.products.single { it.code == "SP-PJ-1L" }
        rule.waitUntil(10_000) { c.stock.any { it.productId == juice.productId && it.availableBase > 0 } }
        val onTruck = c.stock.single { it.productId == juice.productId }.availableBase
        rule.onNodeWithTag("product-price-0",useUnmergedTree = true).assertTextEquals("Priced by the office")
        captureVanScreenshot(rule,"24-find-product","product-search")
        rule.onNodeWithTag("product-search").performTextInput("chunks")
        rule.onNodeWithTag("product-count").assertTextEquals("1 match")
        rule.onNodeWithTag("product-0").assertTextContains("Pineapple Chunks 432g",substring = true)
        rule.onNodeWithTag("product-clear").performClick()
        rule.onNodeWithTag("product-search").performTextInput("sppj1l")
        rule.onNodeWithTag("product-0").assertTextContains("Pineapple Juice 1L",substring = true)
        rule.onNodeWithTag("product-available-0",useUnmergedTree = true).assertTextEquals("${juice.displayQuantity(onTruck)} PC")
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
        mount(); open(Page.PRINTER)
        rule.onNodeWithText("Printer & scanner").assertIsDisplayed()
        rule.onNodeWithText("Print test receipt").assertExists()
        rule.onNodeWithText("Scan with camera").assertExists()
        // The existing printer device suite, not this UI smoke test, prints the real receipt.
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
    @Test fun betaBuildHidesUnfinishedSellingAndShowsReportAnIssue() {
        mount(features = VanFeatures.forBuild(debug = false,webUrl = "https://beta.sunpride.example"))
        assertFalse(VanFeature.SELLING_PREVIEW in c.features)
        rule.onAllNodesWithTag("new-sale").assertCountEquals(0)
        rule.onNodeWithTag("report-issue").performScrollTo().assertIsDisplayed()
        captureVanScreenshot(rule,"30-beta-home","home-primary")
        open(Page.CUSTOMERS)
        rule.onNodeWithTag("customer-route-0").performClick()
        rule.onAllNodesWithTag("selling-preview").assertCountEquals(0)
        rule.onAllNodesWithText("Selling comes in the next update").assertCountEquals(0)
    }
    @Test fun devBuildKeepsSellingPreviewAndHidesReportWithoutWebUrl() {
        mount()
        rule.onNodeWithTag("new-sale").performScrollTo().assertExists()
        rule.onAllNodesWithTag("report-issue").assertCountEquals(0)
        open(Page.CUSTOMERS)
        rule.onNodeWithTag("customer-route-0").performClick()
        rule.onNodeWithTag("selling-preview").assertExists()
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
        rule.onNodeWithTag("customer-walk_in-0").performClick(); captureVanScreenshot(rule,"20-customer-detail","primary")
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
