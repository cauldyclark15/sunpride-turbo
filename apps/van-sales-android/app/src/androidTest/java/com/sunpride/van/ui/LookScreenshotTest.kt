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
import com.sunpride.catalogue.CatalogueDetails
import com.sunpride.catalogue.CatalogueImage
import com.sunpride.catalogue.CataloguePack
import com.sunpride.van.data.BarcodeUnit
import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import com.sunpride.van.pos.CartLine
import com.sunpride.van.pos.PosMoney
import com.sunpride.van.pos.ProductSearch
import com.sunpride.van.selling.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.security.MessageDigest

/**
 * IP-LOOK screenshots of the restyled selling kit on a real 720x1440 display (an emulator at that size; never a physical phone).
 * Each test draws one screen with fixture products and saves a full-display PNG through [captureVanScreenshot]. Fixture data only:
 * no network, no store, nothing written to a real database.
 */
class LookScreenshotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val now = System.currentTimeMillis()
    private fun sampleCatalogue(): CatalogueDetails {
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        val bytes = ctx.assets.open("sample-catalogue.jpg").use { it.readBytes() }
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
    )
    private val price = mapOf("p1" to 19467L, "p2" to 8755L, "p3" to 2987L, "p4" to 4500L, "p5" to 9500L, "p6" to 18900L, "p7" to 12900L, "p8" to 2450L)
    private val stock = products.mapIndexed { i, p -> TruckStock(p.productId, if (i == 3) 0L else 24L - i, 0L) }
    private val prices = products.map { PriceLine("pl", it.productId, "PC", price.getValue(it.productId), "PHP", 0L, null) }

    private fun show(content: @Composable () -> Unit) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) { content() }
        }
        rule.waitForIdle()
    }

    private fun shot(name: String) = captureVanScreenshot(rule, name)

    @Composable private fun Grid(initial: List<CartLine>, place: SellingPlace, title: String, subtitle: String, name: String, role: String, cartOpen: Boolean = false, message: String? = null) {
        var cart by remember { mutableStateOf(initial) }
        var open by remember { mutableStateOf(cartOpen) }
        val index = remember { ProductSearch(products, stock, prices, now) }
        val rows = cart.map { l ->
            val p = products.first { it.productId == l.productId }
            CartRowUi(l.productId, p, l.quantityBase, PosMoney.format(price.getValue(l.productId), "PHP") + " each", PosMoney.format(price.getValue(l.productId) * l.quantityBase, "PHP"), null,
                stock.first { it.productId == l.productId }.availableBase)
        }
        val total = cart.sumOf { price.getValue(it.productId) * it.quantityBase }
        SellingBrowse(title, subtitle, onBack = {}, place = place, search = index, scanProducts = products, currentLines = { cart },
            onSetLine = { id, base -> cart = SellingCart.set(cart, id, base) }, rows = rows, totalLabel = PosMoney.format(total, "PHP"), chargeEnabled = cart.isNotEmpty(), onCharge = {},
            cartOpen = open, onCartOpen = { open = it }, message = message, busy = false, cashierName = name, roleLabel = role)
    }

    @Test fun A1_storeGridEmpty() { show { Grid(emptyList(), SellingPlace.STORE, "Store sale", "Sample Cebu South Store", "Hector Ramos", "Cashier") }; shot("look-01-store-grid") }

    @Test fun A2_storeGridWithItems() {
        show { Grid(listOf(CartLine("p1", 2), CartLine("p2", 1)), SellingPlace.STORE, "Store sale", "Sample Cebu South Store", "Hector Ramos", "Cashier") }
        rule.onNodeWithTag("grid-SMP-001").assertExists()
        shot("look-02-store-grid-items")
    }

    @Test fun A3_vanGrid() { show { Grid(listOf(CartLine("p3", 3)), SellingPlace.VAN, "Sale", "Aling Nena Store · C-1042", "Paolo Reyes", "Van seller") }; shot("look-03-van-grid") }

    @Test fun A4_cartSheet() {
        show { Grid(listOf(CartLine("p1", 2), CartLine("p2", 1)), SellingPlace.STORE, "Store sale", "Sample Cebu South Store", "Hector Ramos", "Cashier", cartOpen = true) }
        rule.onNodeWithTag("cart-sheet").assertIsDisplayed()
        shot("look-04-cart-sheet")
    }

    @Test fun A5_editLineSheet() {
        show { Grid(listOf(CartLine("p1", 2)), SellingPlace.STORE, "Store sale", "Sample Cebu South Store", "Hector Ramos", "Cashier") }
        rule.onNodeWithTag("grid-SMP-001").performTouchInput { longClick() }
        rule.onNodeWithTag("qty-keypad").assertIsDisplayed()
        rule.onNodeWithTag("qty-key-5").performClick()
        shot("look-05-edit-line-sheet")
    }

    @Test fun A6_discountSheet() {
        show { Box(Modifier.fillMaxSize()) { ClaimSheet(listOf("p1" to "Sample Beef Burger Patties 1kg", "p2" to "Sample Calamansi Juice 1L"), null, {}, null, {}) } }
        rule.onNodeWithTag("claim-type-senior").performClick()
        shot("look-06-discount-sheet")
    }

    @Test fun A7_searchPalette() {
        show { Grid(listOf(CartLine("p2", 1)), SellingPlace.STORE, "Store sale", "Sample Cebu South Store", "Hector Ramos", "Cashier") }
        rule.onNodeWithTag("sale-add-product").performClick()
        rule.onNodeWithTag("product-search").performTextInput("juice")
        rule.waitForIdle()
        shot("look-07-search")
    }

    private fun tenders() = listOf(TenderChoice("cash", "Cash", TenderKind.CASH), TenderChoice("gcash", "GCash / e-wallet", TenderKind.OTHER), TenderChoice("card", "Card", TenderKind.OTHER), TenderChoice("split", "Split", TenderKind.OTHER))

    @Composable private fun Pay(total: Long, tendered: Long?) {
        var t by remember { mutableStateOf(tendered) }
        PaymentStep("Payment", total, tenders(), "cash", {}, t, { t = it }, emptyList(), saving = false, canPay = (t ?: 0) >= total, exactEnabled = true, onExact = {}, onPay = {}, onBack = {})
    }

    @Test fun B1_payment() { show { Pay(47689, 50000) }; shot("look-08-payment") }

    /** The seven-figure amounts that used to lose their last digit on 720px: they must shrink, never clip. */
    @Test fun B2_paymentLongAmountsNeverClip() {
        show { Pay(123_456_789, 123_500_000) }
        for (tag in listOf("checkout-total", "checkout-tendered", "checkout-change")) {
            val node = rule.onNodeWithTag(tag).fetchSemanticsNode()
            val results = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
            node.config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action?.invoke(results)
            assertFalse("$tag clipped: ${results.firstOrNull()?.hasVisualOverflow}", results.first().hasVisualOverflow)
        }
        rule.onNodeWithTag("checkout-total").assertTextEquals("₱1,234,567.89")
        shot("look-09-payment-long-amount")
    }

    @Test fun B3_complete() {
        show { CompleteStep("Sale saved", "₱500.00", "₱476.89", "₱23.11", "Saved on this phone", {}, "Done", {}) { } }
        shot("look-10-complete")
    }

    /** Till headers: store home, open session and the blind count, driven through the real VanApp on the retail fixture database. */
    @Test fun C1_tillScreens() {
        val f = com.sunpride.van.retail.RetailRoomFixture()
        try {
            val mode = java.util.UUID.randomUUID().toString()
            val o = org.json.JSONObject(f.snapshot())
            o.put("trip", org.json.JSONObject.NULL).put("load", org.json.JSONObject.NULL)
            o.getJSONObject("policy").put("storePos", org.json.JSONObject().put("version", 1).put("mode", "store").put("modeVersionId", mode)
                .put("registerId", java.util.UUID.randomUUID().toString()).put("registerName", "Sample Cebu South Till 1").put("storeName", "Sample Cebu South Store")
                .put("terminalCode", "SMP-POS-02").put("policyId", java.util.UUID.randomUUID().toString()).put("shift", org.json.JSONObject.NULL)
                .put("allowLocalSwitch", false).put("transactionsEnabled", true))
            kotlinx.coroutines.runBlocking { f.store.replaceBootstrap(o.toString()) }
            val c = VanController(f.repository(), com.sunpride.van.AppEnvironment("https://retail.invalid"))
            var mounted by mutableStateOf(true)
            rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
            rule.setContent { if (mounted) VanApp(c, restore = false) }
            rule.waitUntil(10_000) { c.initialized && c.storeMode }
            shot("look-11-till-home")
            rule.onNodeWithTag("store-open-session").performClick()
            rule.onNodeWithTag("store-float-amount").performTextInput("2000")
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            shot("look-12-till-open")
            rule.onNodeWithTag("save-store-open").performClick()
            rule.waitUntil(10_000) { !c.busy && c.storePos.shift != null }
            rule.waitUntil(10_000) { c.page != Page.STORE_OPEN }
            rule.runOnUiThread { c.open(Page.HOME) }; rule.waitForIdle()
            rule.onNodeWithTag("store-end-session").performScrollTo().performClick()
            rule.onNodeWithTag("store-end-continue").performClick()
            rule.onNodeWithTag("store-count-amount").performTextInput("1990")
            androidx.test.espresso.Espresso.closeSoftKeyboard()
            shot("look-13-till-close")
            rule.runOnUiThread { mounted = false }
            rule.waitForIdle()
        } finally { f.close() }
    }
}
