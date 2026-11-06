package com.sunpride.van.ui

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.sunpride.catalogue.CatalogueDetails
import com.sunpride.catalogue.CatalogueImage
import com.sunpride.catalogue.CataloguePack
import com.sunpride.van.AppEnvironment
import com.sunpride.van.data.*
import com.sunpride.van.pos.CartLine
import com.sunpride.van.pos.PosMoney
import com.sunpride.van.pos.ProductSearch
import com.sunpride.van.selling.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.security.MessageDigest

/**
 * POS v2 screenshots on a real 720x1440 display (an emulator at that size; never a physical phone). Fixture data only: no network, no live
 * store. Group A draws the selling kit inside the real bottom-bar shell; B drives the real VanApp in Store mode; C drives it in Van mode.
 */
class PosV2ScreenshotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val now = System.currentTimeMillis()

    private fun sampleCatalogue(): CatalogueDetails {
        val bytes = context.assets.open("sample-catalogue.jpg").use { it.readBytes() }
        val sha = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
        return CatalogueDetails(1, "00000000-0000-4000-8000-000000000001", "sample", true, "SAMPLE description", "SAMPLE ingredients", "SAMPLE allergens", "SAMPLE storage", 180,
            "SAMPLE case specs", listOf(CataloguePack("CASE", "Case", 24, 1, "PC")), CatalogueImage("/api/v1/masters/catalogue-images/00000000-0000-4000-8000-000000000001", sha, bytes.size))
    }
    private fun product(i: Int, code: String, name: String, category: String, photo: Boolean = false, caseOf: Long? = null) =
        Product("p$i", code, name, "PC", 1, listOf("48000000000$i"), caseOf?.let { listOf(BarcodeUnit("48100000000$i", "CASE", it)) } ?: emptyList(),
            catalogue = if (photo) sampleCatalogue() else null, category = category)
    private val products = listOf(
        product(1, "SMP-001", "Sample Beef Burger Patties 1kg", "Meat", photo = true, caseOf = 12),
        product(2, "SMP-002", "Sample Calamansi Juice 1L", "Drinks", photo = true),
        product(3, "SMP-003", "Sample Caldereta Sauce 200g", "Sauces"),
        product(4, "SMP-004", "Sample canned meat 150g", "Canned"),
        product(5, "SMP-005", "Sample Pineapple Juice 1L", "Drinks"),
        product(6, "SMP-006", "Sample Hotdog Jumbo 500g", "Meat"),
        product(7, "SMP-007", "Sample Tomato Sauce 1kg", "Sauces"),
        product(8, "SMP-008", "Sample Sardines in Tomato 155g", "Canned"),
        product(9, "SMP-009", "Sample Longganisa 500g", "Meat"),
        product(10, "SMP-010", "Sample Tocino 500g", "Meat"),
    )
    private val price = mapOf("p1" to 19467L, "p2" to 8755L, "p3" to 2987L, "p4" to 4500L, "p5" to 9500L, "p6" to 18900L, "p7" to 12900L, "p8" to 2450L, "p9" to 21000L, "p10" to 19500L)
    private val stock = products.mapIndexed { i, p -> TruckStock(p.productId, if (i == 3) 0L else 24L - i, 0L) }
    private val prices = products.map { PriceLine("pl", it.productId, "PC", price.getValue(it.productId), "PHP", 0L, null) }

    @org.junit.After fun closeFixtures() { rule.runOnUiThread { host = null }; rule.waitForIdle(); repositories.forEach { it.close() }; storeFixture?.close() }

    private fun shot(name: String) = captureVanScreenshot(rule, "pos2-$name")

    // ---------------------------------------------------------------- A: the kit, inside the real shell
    private var storeFixture: com.sunpride.van.retail.RetailRoomFixture? = null
    private var shellController: VanController? = null

    private fun storeController(open: Boolean): VanController {
        val f = com.sunpride.van.retail.RetailRoomFixture().also { storeFixture = it }
        val mode = java.util.UUID.randomUUID().toString()
        val o = org.json.JSONObject(f.snapshot())
        o.put("trip", org.json.JSONObject.NULL).put("load", org.json.JSONObject.NULL)
        val shift: Any = if (open) org.json.JSONObject().put("id", java.util.UUID.randomUUID().toString()).put("openedAt", now - 3_600_000).put("floatCentavos", "200000") else org.json.JSONObject.NULL
        o.getJSONObject("policy").put("storePos", org.json.JSONObject().put("version", 1).put("mode", "store").put("modeVersionId", mode)
            .put("registerId", java.util.UUID.randomUUID().toString()).put("registerName", "Sample Cebu South Till 1").put("storeName", "Sample Cebu South Store")
            .put("terminalCode", "SMP-POS-02").put("policyId", java.util.UUID.randomUUID().toString()).put("shift", org.json.JSONObject.NULL)
            .put("allowLocalSwitch", false).put("transactionsEnabled", true))
        runBlocking { f.store.replaceBootstrap(o.toString()) }
        return VanController(f.repository(), AppEnvironment("https://retail.invalid")).also { shellController = it }
    }

    /** Draws [content] inside AppShell on [page] of a Store-mode controller, so the bar and its selected tab are the real ones. */
    private fun shell(page: Page, content: @Composable () -> Unit) {
        val c = storeController(open = false)
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            LaunchedEffect(c) { c.run(false) }
            MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) { AppShell(c) { content() } }
        }
        rule.waitUntil(10_000) { c.initialized && c.storeMode }
        rule.runOnUiThread { c.open(page) }
        rule.waitForIdle()
    }

    private fun show(content: @Composable () -> Unit) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) { content() } }
        rule.waitForIdle()
    }

    @Composable private fun Grid(initial: List<CartLine>, cartOpen: Boolean = false, message: String? = null) {
        var cart by remember { mutableStateOf(initial) }
        var open by remember { mutableStateOf(cartOpen) }
        val index = remember { ProductSearch(products, stock, prices, now) }
        val rows = cart.map { l ->
            val p = products.first { it.productId == l.productId }
            CartRowUi(l.productId, p, l.quantityBase, PosMoney.format(price.getValue(l.productId), "PHP") + " each", PosMoney.format(price.getValue(l.productId) * l.quantityBase, "PHP"), null,
                stock.first { it.productId == l.productId }.availableBase)
        }
        val total = cart.sumOf { price.getValue(it.productId) * it.quantityBase }
        val c = shellController
        SellingBrowse("Store sale", "Sample Cebu South Store", onBack = null, place = SellingPlace.STORE, search = index, scanProducts = products, currentLines = { cart },
            onSetLine = { id, base -> cart = SellingCart.set(cart, id, base) }, rows = rows, totalLabel = PosMoney.format(total, "PHP"), chargeEnabled = cart.isNotEmpty(), onCharge = {},
            cartOpen = open, onCartOpen = { open = it }, message = message, busy = false, cashierName = "Hector Ramos", roleLabel = "Cashier",
            syncBadge = c?.let { { SyncPill(it) } })
    }

    @Test fun A1_sellGridEmpty() { shell(Page.STORE_SALE) { Grid(emptyList()) }; shot("a1-sell-empty") }
    @Test fun A2_sellGridItems() { shell(Page.STORE_SALE) { Grid(listOf(CartLine("p1", 2), CartLine("p2", 1))) }; shot("a2-sell-items") }
    @Test fun A3_cartSheet() { shell(Page.STORE_SALE) { Grid(listOf(CartLine("p1", 2), CartLine("p2", 1)), cartOpen = true) }; rule.onNodeWithTag("cart-sheet").assertIsDisplayed(); shot("a3-cart") }

    private fun tenders() = listOf(TenderChoice("cash", "Cash", TenderKind.CASH), TenderChoice("gcash", "GCash", TenderKind.OTHER), TenderChoice("card", "Card", TenderKind.OTHER), TenderChoice("split", "Split", TenderKind.OTHER))

    /** Mirrors the store host: EXACT only marks "exact"; the sale is saved only by [onPay]. */
    @Composable private fun Pay(total: Long, discount: String? = null, startExact: Boolean = false, customer: String? = null, onPayed: () -> Unit = {}) {
        var picked by remember { mutableStateOf<Long?>(null) }
        var exact by remember { mutableStateOf(startExact) }
        val tendered = QuickCash.effectiveTenderedMinor(exact, total, picked)
        PaymentStep("Payment", total, tenders(), "cash", {}, tendered, { exact = false; picked = it }, emptyList(), saving = false, canPay = (tendered ?: 0) >= total, exactEnabled = true,
            onExact = { exact = true; picked = null }, exactActive = exact, onPay = onPayed, onBack = {}, subtitle = "Sample Cebu South Store",
            options = listOf(PayOption("Discount", discount, "store-claim", {}, active = discount != null), PayOption("Customer", customer, "store-more", {}, active = customer != null)))
    }

    @Test fun B1_paymentFresh() { show { Pay(47689) }; shot("b1-payment") }
    @Test fun B2_paymentAfterExact() {
        var payed = false
        show { Pay(47689, onPayed = { payed = true }) }
        rule.onNodeWithTag("pay-exact").performClick()
        rule.onNodeWithTag("checkout-tendered").assertTextEquals("₱476.89")
        rule.onNodeWithTag("checkout-change").assertTextEquals("₱0.00")
        rule.onNodeWithTag("complete-sale").assertIsEnabled()
        assertFalse("EXACT must not complete the sale", payed)
        rule.onNodeWithTag("store-claim").assertIsDisplayed(); rule.onNodeWithTag("store-more").assertIsDisplayed(); rule.onNodeWithTag("complete-sale").assertIsDisplayed()
        shot("b2-payment-exact")
        rule.onNodeWithTag("complete-sale").performClick()
        assertTrue("only the Complete button saves", payed)
    }
    @Test fun B3_paymentDiscountAndCustomer() { show { Pay(42920, discount = "Senior citizen", startExact = true, customer = "0917 555 0100") }; shot("b3-payment-discount") }
    @Test fun B4_paymentBillWithChange() { show { Pay(2987) }; rule.onNodeWithTag("quick-cash-50").performClick(); rule.onNodeWithTag("checkout-change").assertTextEquals("₱20.13"); shot("b4-payment-bill") }
    @Test fun B5_customerSheet() {
        show { Box(Modifier.fillMaxSize()) { StoreCustomerSheet("09175550100", {}, "Maria Santos · 120 points", true, {}, null, "", {}, true, false, {}, "", {}, false, {}) } }
        shot("b5-customer-sheet")
    }
    @Test fun B6_discountSheet() {
        show { Box(Modifier.fillMaxSize()) { ClaimSheet(listOf("p1" to "Sample Beef Burger Patties 1kg", "p2" to "Sample Calamansi Juice 1L"), null, {}, null, {}) } }
        rule.onNodeWithTag("claim-type-senior").performClick()
        shot("b6-discount-sheet")
    }
    @Test fun B7_complete() { show { CompleteStep("Sale saved", "₱476.89", "₱476.89", "₱0.00", "SAMPLE-SMP-T3-STORE-SI-000000003", {}, "Receipts", {}) { } }; shot("b7-complete") }

    // ---------------------------------------------------------------- B: the real app in Store mode
    @Test fun C1_storeTabs() {
        try {
            val c = storeController(open = false)
            var mounted by mutableStateOf(true)
            rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
            rule.setContent { if (mounted) VanApp(c, restore = false) }
            rule.waitUntil(10_000) { c.initialized && c.storeMode }
            shot("c1-till-closed")
            rule.onNodeWithTag("nav-sell").performClick(); rule.waitForIdle()
            shot("c2-sell-locked")
            rule.onNodeWithTag("nav-more").performClick(); rule.waitForIdle()
            shot("c3-more")
            rule.onNodeWithTag("nav-sales").performClick(); rule.waitForIdle()
            shot("c4-sales-empty")
            rule.onNodeWithTag("nav-stock").performClick(); rule.waitForIdle()
            shot("c5-stock")
            rule.onNodeWithTag("nav-till").performClick(); rule.waitForIdle()
            rule.onNodeWithTag("store-open-session").performClick()
            rule.onNodeWithTag("store-float-amount").performTextInput("2000")
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            shot("c6-open-session")
            rule.onNodeWithTag("save-store-open").performClick()
            rule.waitUntil(10_000) { !c.busy && c.storePos.shift != null }
            rule.waitUntil(10_000) { c.page == Page.STORE_SALE }
            shot("c7-sell-open-no-products")
            rule.onNodeWithTag("nav-till").performClick(); rule.waitForIdle()
            shot("c8-till-open")
            for ((page, name) in listOf(Page.STORE_READS to "c9-xz-cash", Page.STORE_DEPOSIT to "c10-deposit", Page.STORE_CUSTOMERS to "c11-customers", Page.POS_MODE to "c12-pos-mode", Page.SYNC to "c13-sync", Page.ACCOUNT to "c14-account")) {
                rule.runOnUiThread { c.open(page) }; rule.waitForIdle(); shot(name)
            }
            rule.runOnUiThread { c.open(Page.HOME) }; rule.waitForIdle()
            rule.onNodeWithTag("store-end-session").performScrollTo().performClick(); rule.waitForIdle()
            shot("c15-close-till-sheet")
            rule.runOnUiThread { mounted = false }
            rule.waitForIdle()
        } finally { storeFixture?.close() }
    }

    // ---------------------------------------------------------------- C: the real app in Van mode (practice fixture)
    private val repositories = mutableListOf<VanRepository>()
    private var host by mutableStateOf<VanController?>(null)

    private fun mountVan() {
        WorkManager.getInstance(context).cancelUniqueWork("van-sales-sync-stub").result.get()
        context.deleteDatabase("van_stub_store.db")
        context.getSharedPreferences("van_fixture_backend", 0).edit().clear().commit()
        val repo = VanRepository.forWorker(context, true).also { repositories += it }
        val ctrl = VanController(repo, AppEnvironment("", ""), true) {
            withContext(Dispatchers.IO) { "AAAA BBBB CCCC DDDD" }
        }
        host = ctrl
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { host?.let { VanApp(it, restore = true) } }
        rule.waitUntil(20_000) { ctrl.initialized && !ctrl.busy && ctrl.trip != null && ctrl.products.size == 2 && ctrl.policy != null }
    }

    @Test fun D1_vanTabs() {
        try {
            mountVan()
            val c = host!!
            shot("d1-today")
            rule.onNodeWithTag("nav-sell").performClick(); rule.waitForIdle()
            shot("d2-sell-customers")
            rule.onNodeWithTag("nav-stock").performClick(); rule.waitForIdle()
            shot("d3-stock")
            rule.onNodeWithTag("nav-receipts").performClick(); rule.waitForIdle()
            shot("d4-receipts-empty")
            rule.onNodeWithTag("nav-more").performClick(); rule.waitForIdle()
            shot("d5-more")
            for ((page, name) in listOf(Page.PRODUCTS to "d6-find-product", Page.CATALOGUE to "d7-catalogue", Page.WALK_IN to "d8-walk-in", Page.ACCOUNT to "d9-account", Page.SYNC to "d10-sync", Page.PRINTER to "d11-printer", Page.POS_MODE to "d12-pos-mode")) {
                rule.runOnUiThread { c.open(page) }; rule.waitForIdle(); shot(name)
            }
            rule.runOnUiThread { c.select(c.customers.first { it.source == "route" }) }; rule.waitForIdle(); shot("d13-customer")
            rule.onNodeWithTag("nav-today").performClick(); rule.waitForIdle()
            assertEquals(Page.HOME, c.page)
        } finally { rule.runOnUiThread { host = null }; rule.waitForIdle(); repositories.forEach { it.close() } }
    }

    @Test fun D2_vanSellFlow() {
        try {
            mountVan()
            val c = host!!
            // load and start the trip so selling opens (same steps the device test uses)
            rule.runOnUiThread { c.open(Page.LOAD) }; rule.waitForIdle()
            rule.onNodeWithTag("confirm-load").performClick()
            rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
            runBlocking { c.repository.syncNow() }; rule.waitUntil(10_000) { c.trip?.status == "loaded" }
            rule.runOnUiThread { c.open(Page.START) }; rule.waitForIdle()
            rule.onNodeWithTag("confirm-truck").performClick(); rule.onNodeWithTag("confirm-route").performClick()
            typeOpeningFloat(rule, "2000"); rule.onNodeWithTag("start-trip").performClick()
            rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy }
            runBlocking { c.repository.syncNow() }; rule.waitUntil(10_000) { c.trip?.status == "active" }
            rule.runOnUiThread { c.open(Page.HOME) }; rule.waitForIdle()
            shot("e1-today-active")
            rule.onNodeWithTag("nav-sell").performClick(); rule.waitForIdle()
            rule.runOnUiThread { c.startSale(c.customers.first { it.source == "route" }) }
            rule.waitUntil(10_000) { c.page == Page.SALE && c.retailLoaded }
            shot("e2-van-sale-empty")
            val juice = c.products.first()
            rule.runOnUiThread { c.addToSale(juice.productId, 2) }
            rule.waitForIdle()
            shot("e3-van-sale-items")
            rule.onNodeWithTag("checkout").performClick()
            rule.waitUntil(10_000) { c.page == Page.CHECKOUT }
            rule.waitForIdle()
            rule.onAllNodesWithTag("nav-bar").assertCountEquals(0)
            shot("e4-van-payment")
            rule.onNodeWithTag("pay-exact").performClick(); rule.waitForIdle()
            assertEquals("EXACT does not complete the van sale", Page.CHECKOUT, c.page)
            rule.onNodeWithTag("checkout-change").assertTextEquals("₱0.00")
            shot("e5-van-payment-exact")
            rule.onNodeWithTag("complete-sale").performClick()
            rule.waitUntil(10_000) { c.page == Page.SALE_DONE }
            shot("e6-van-complete")
            for ((page, name) in listOf(Page.CASH to "e7-count-cash", Page.STOCK_COUNT to "e8-count-stock", Page.CLOSE_TRIP to "e9-close-trip", Page.RECEIPTS to "e10-receipts-one")) {
                rule.runOnUiThread { c.open(page) }; rule.waitForIdle(); shot(name)
            }
        } finally { rule.runOnUiThread { host = null }; rule.waitForIdle(); repositories.forEach { it.close() } }
    }

    @Test fun F1_signIn() {
        try {
            WorkManager.getInstance(context).cancelUniqueWork("van-sales-sync-stub").result.get()
            context.deleteDatabase("van_stub_store.db")
            context.getSharedPreferences("van_fixture_backend", 0).edit().clear().commit()
            val repo = VanRepository.forWorker(context, true).also { repositories += it }
            val ctrl = VanController(repo, AppEnvironment("", ""), true) { withContext(Dispatchers.IO) { "AAAA BBBB CCCC DDDD" } }
            host = ctrl
            rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
            rule.setContent { host?.let { VanApp(it, restore = false) } }
            rule.waitUntil(10_000) { ctrl.initialized }
            shot("f1-sign-in")
        } finally { rule.runOnUiThread { host = null }; rule.waitForIdle() }
    }
}
