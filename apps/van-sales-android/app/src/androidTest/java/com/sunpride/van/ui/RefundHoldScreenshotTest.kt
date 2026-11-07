package com.sunpride.van.ui

import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.printing.ReceiptCommand
import com.sunpride.van.printing.ReceiptLayoutFormatter
import com.sunpride.van.printing.RefundSlip
import com.sunpride.van.printing.RefundSlipFacts
import com.sunpride.van.selling.*
import com.sunpride.van.storepos.Supervisor
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

/**
 * IP-REFUND / IP-HOLD screenshots on the 720x1440 emulator (never a physical phone). Fixture data only: the refund sheet, its confirm
 * state with a supervisor approval, the printed slip, the held-carts list, and the Hold button in the cart.
 */
class RefundHoldScreenshotTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private val now = 1_794_000_000_000L

    private fun show(content: @Composable () -> Unit) {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        rule.setContent { MaterialTheme(colorScheme = SunprideTokens.lightColors, typography = SunprideTokens.typography, shapes = SunprideTokens.shapes) { content() } }
        rule.waitForIdle()
    }
    private fun shot(name: String) = captureVanScreenshot(rule, "refund-hold-$name")

    // ------------------------------------------------------------ refund
    private fun line(id: String, name: String, qty: Int, unit: Long, discount: Long = 0) = JSONObject().put("productId", id).put("description", name).put("uom", "PC")
        .put("quantity", qty).put("quantityBase", qty).put("unitPriceCentavos", unit).put("lineTotalCentavos", unit * qty - discount).put("discountCentavos", discount)
    private val receipt = JSONObject().put("totalMinor", "107859")
        .put("tax", JSONObject().put("vatableSalesMinor", "96302").put("vatMinor", "11557").put("vatExemptMinor", "0").put("zeroRatedMinor", "0").put("totalMinor", "107859")).put("lines", JSONArray()
        .put(line("p1", "Sample Beef Burger Patties 1kg", 3, 19467, 1000))
        .put(line("p2", "Sample Calamansi Juice 1L", 2, 8755))
        .put(line("p3", "Sample Caldereta Sauce 200g", 4, 2987))
        .put(line("p4", "Sample Longganisa 500g", 1, 21000)))
    private val reasons = listOf(
        RefundReason("RF-CHANGED", "Customer changed their mind", "sellable", false),
        RefundReason("RF-WRONG", "Wrong item given", "sellable", false),
        RefundReason("RF-QUALITY", "Quality problem", "damaged", true),
        RefundReason("RF-EXPIRED", "Expired or spoiled", "damaged", true))
    private val policy = RefundPolicy(50_000L, reasons, null, emptyList())
    private fun model(problem: String? = null) = RefundSheetModel("SAMPLE-SMP-T3-STORE-SI-000000003", "Maria Santos", receipt, RefundMath.saleLines(receipt), mapOf(2 to 1L), policy, problem)
    private val supervisors = listOf(Supervisor("s1", "Ana Reyes", "pin1", "salt", "hash"), Supervisor("s2", "Ben Cruz", "pin2", "salt", "hash"))

    private fun n(tag: String) = rule.onNodeWithTag(tag, useUnmergedTree = true)
    /** The refund list is lazy, so rows below the fold only exist once the list has scrolled to them. */
    private fun toRow(tag: String): SemanticsNodeInteraction { n("refund-lines").performScrollToNode(hasTestTag(tag)); return n(tag) }

    @Test fun R1_refundPicker() {
        show { Box(Modifier.fillMaxSize()) { RefundSheet(model(), RefundApprovalKind.PIN, supervisors, busy = false, error = null, onConfirm = {}, onClose = {}) } }
        n("refund-sheet").assertIsDisplayed()
        n("refund-confirm").assertIsNotEnabled()
        shot("r1-picker-empty")
        n("refund-line-0-plus").performClick(); n("refund-line-0-plus").performClick(); rule.waitForIdle()
        shot("r2-picker-chosen")
        n("refund-line-0-amount").assertIsDisplayed()
    }

    @Test fun R2_refundConfirmWithApproval() {
        show { Box(Modifier.fillMaxSize()) { RefundSheet(model(), RefundApprovalKind.PIN, supervisors, busy = false, error = null, onConfirm = {}, onClose = {}) } }
        repeat(3) { n("refund-line-0-plus").performClick() }
        toRow("refund-line-1-plus").performClick(); n("refund-line-1-plus").performClick()
        toRow("refund-reason-RF-QUALITY").performClick()
        toRow("refund-note").performTextInput("Seal broken on arrival")
        androidx.test.espresso.Espresso.closeSoftKeyboard(); rule.waitForIdle()
        toRow("refund-needs-approval").assertIsDisplayed()
        shot("r3-confirm-approval")
        rule.onNodeWithText("Ana Reyes", useUnmergedTree = true).performClick(); rule.waitForIdle()
        shot("r3b-supervisor-picked-pin")
        n("refund-confirm").assertIsDisplayed()
        // the footer total and Confirm stay on screen while the list scrolls
        n("refund-total").assertIsDisplayed()
    }

    @Test fun R3_refundCodeOnVan() {
        show { Box(Modifier.fillMaxSize()) { RefundSheet(model(), RefundApprovalKind.CODE, emptyList(), busy = false, error = null, onConfirm = {}, onClose = {}) } }
        repeat(3) { n("refund-line-0-plus").performClick() }
        toRow("refund-line-1-plus").performClick(); n("refund-line-1-plus").performClick()
        toRow("refund-reason-RF-CHANGED").performClick()
        toRow("refund-code"); rule.waitForIdle()
        shot("r4-van-code")
    }

    /** b33: a failure while saving shows in the footer beside Confirm, even when the list is long and scrolled to the top. */
    @Test fun R8_savingErrorIsVisibleBesideConfirm() {
        val msg = "This register has no credit memo numbers yet. Sync, then try again."
        var error by mutableStateOf<String?>(null)
        show { Box(Modifier.fillMaxSize()) { RefundSheet(model(), RefundApprovalKind.PIN, supervisors, busy = false, error = error, onConfirm = { error = msg }, onClose = {}) } }
        n("refund-line-0-plus").performClick()
        toRow("refund-reason-RF-CHANGED").performClick(); rule.waitForIdle()
        n("refund-lines").performScrollToIndex(0)
        n("refund-confirm").assertIsEnabled().performClick(); rule.waitForIdle()
        n("refund-error").assertIsDisplayed().assertTextEquals(msg)
        shot("r8-saving-error")
    }

    @Test fun R4_refundBlocked() {
        show { Box(Modifier.fillMaxSize()) { RefundSheet(model("This trip is already counted, so its sales cannot be refunded."), RefundApprovalKind.CODE, emptyList(), false, null, {}, {}) } }
        shot("r5-blocked")
        n("refund-blocked").assertIsDisplayed()
    }

    @Test fun R5_refundDone() {
        show { Box(Modifier.fillMaxSize()) { RefundDoneDialog("SAMPLE-SMP-T3-STORE-CM-000000001", "SAMPLE-SMP-T3-STORE-SI-000000003", 64_419L, 40_000L, true, "Refund slip printed", false, {}, {}) } }
        n("refund-done").assertIsDisplayed()
        shot("r6-done")
    }

    @Test fun R6_refundSlip() {
        val lines = RefundMath.saleLines(receipt)
        val plan = RefundMath.plan(receipt, mapOf(2 to 1L), mapOf(0 to 2L, 1 to 1L))
        val facts = RefundSlipFacts.of("SAMPLE-SMP-T3-STORE-CM-000000001", "SAMPLE-SMP-T3-STORE-SI-000000003", "Maria Santos", "Hector Ramos", "Sample Cebu South Store", plan,
            listOf(RefundTender("cash", "Cash", plan.totalMinor)), reasons[2], "Seal broken on arrival", now, "Ana Reyes", "Sample Foods Inc.", "000-000-000-000", "1 Sample St, Cebu", sample = true)
        assertTrue(lines.size == 4)
        val text = ReceiptLayoutFormatter().format(RefundSlip.document(facts)).filterIsInstance<ReceiptCommand.Line>().joinToString("\n") { it.text }
        assertTrue(text.contains("CREDIT MEMO / REFUND"))
        show { Column(Modifier.fillMaxSize().statusBarsPadding().padding(12.dp).verticalScroll(rememberScrollState())) {
            Text("Refund slip preview (58mm, 32 columns)", style = MaterialTheme.typography.titleMedium)
            Text(text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 14.sp, modifier = Modifier.fillMaxWidth().testTag("slip-text")) } }
        shot("r7-slip")
    }

    // ------------------------------------------------------------ hold
    private fun held(i: Int, name: String, customer: String?, lines: Int, total: String, minutesAgo: Long) = HeldCart("h$i", "store", name, if (i == 1) "Back in 10 minutes" else null,
        customer?.let { "c$i" }, customer, (1..lines).map { HeldLine("p$it", "Sample item $it", 2, 5000) }, total, now - minutesAgo * 60_000)
    private val carts = listOf(held(1, "Ate with the blue bag", "Maria Santos", 3, "₱476.89", 4), held(2, "Held 2", null, 1, "₱89.00", 17), held(3, "Tindahan order", "Lola Remedios Store", 5, "₱1,920.50", 42))

    @Test fun H1_heldCartsList() {
        show { Box(Modifier.fillMaxSize()) { HeldCartsSheet(carts, cartEmpty = true, showCustomer = true, message = null, onRecall = {}, onDiscard = {}, onClose = {}) } }
        rule.onNodeWithTag("held-sheet").assertIsDisplayed()
        shot("h1-held-list")
    }

    @Test fun H2_heldCartsListCartNotEmpty() {
        show { Box(Modifier.fillMaxSize()) { HeldCartsSheet(carts, cartEmpty = false, showCustomer = true, message = "Hold or clear the cart you have first.", onRecall = {}, onDiscard = {}, onClose = {}) } }
        shot("h2-held-list-cart-in-use")
    }

    @Test fun H3_holdDialog() {
        show { Box(Modifier.fillMaxSize()) { HoldCartDialog(3, "₱476.89", null, false, { _, _ -> }, {}) } }
        rule.onNodeWithTag("hold-confirm").assertIsDisplayed()
        shot("h3-hold-dialog")
    }

    private val products = listOf(
        Product("p1", "SMP-001", "Sample Beef Burger Patties 1kg", "PC", 1, listOf("480000000001"), emptyList(), category = "Meat"),
        Product("p2", "SMP-002", "Sample Calamansi Juice 1L", "PC", 1, listOf("480000000002"), emptyList(), category = "Drinks"),
        Product("p3", "SMP-003", "Sample Caldereta Sauce 200g", "PC", 1, listOf("480000000003"), emptyList(), category = "Sauces"))
    private val price = mapOf("p1" to 19467L, "p2" to 8755L, "p3" to 2987L)
    private val stock = products.map { TruckStock(it.productId, 24L, 0L) }
    private val prices = products.map { PriceLine("pl", it.productId, "PC", price.getValue(it.productId), "PHP", 0L, null) }

    @Composable private fun CartHost(initial: List<CartLine>, cartOpen: Boolean, heldCount: Int) {
        var cart by remember { mutableStateOf(initial) }
        var open by remember { mutableStateOf(cartOpen) }
        val index = remember { ProductSearch(products, stock, prices, now) }
        val rows = cart.map { l ->
            val p = products.first { it.productId == l.productId }
            CartRowUi(l.productId, p, l.quantityBase, PosMoney.format(price.getValue(l.productId), "PHP") + " each", PosMoney.format(price.getValue(l.productId) * l.quantityBase, "PHP"), null, 24L)
        }
        val total = cart.sumOf { price.getValue(it.productId) * it.quantityBase }
        val ui = HeldCartsUi(count = heldCount, carts = carts.take(heldCount), onHold = { _, _, _, _, done -> done(null) }, onRecalled = {}, onDiscard = {})
        SellingBrowse("Store sale", "Sample Cebu South Store", onBack = null, place = SellingPlace.STORE, search = index, scanProducts = products, currentLines = { cart },
            onSetLine = { id, base -> cart = SellingCart.set(cart, id, base) }, rows = rows, totalLabel = PosMoney.format(total, "PHP"), chargeEnabled = cart.isNotEmpty(), onCharge = {},
            cartOpen = open, onCartOpen = { open = it }, message = null, busy = false, cashierName = "Hector Ramos", roleLabel = "Cashier", held = ui)
    }

    @Test fun H4_holdButtonInCart() {
        show { CartHost(listOf(CartLine("p1", 2), CartLine("p2", 1)), cartOpen = true, heldCount = 2) }
        rule.onNodeWithTag("cart-sheet").assertIsDisplayed()
        rule.onNodeWithTag("cart-hold").assertIsDisplayed().assertIsEnabled()
        rule.onNodeWithTag("cart-charge").assertIsDisplayed()
        val hold = rule.onNodeWithTag("cart-hold").getUnclippedBoundsInRoot(); val charge = rule.onNodeWithTag("cart-charge").getUnclippedBoundsInRoot()
        assertTrue("Hold ends at ${hold.right}, Charge starts at ${charge.left}", hold.right <= charge.left)
        shot("h4-hold-button-in-cart")
        rule.onNodeWithTag("cart-hold").performClick(); rule.waitForIdle()
        rule.onNodeWithTag("hold-sheet").assertIsDisplayed()
        shot("h5-hold-dialog-from-cart")
    }

    @Test fun H5_heldBadgeOnSellGrid() {
        show { CartHost(emptyList(), cartOpen = false, heldCount = 3) }
        rule.onNodeWithTag("held-open").assertIsDisplayed()
        rule.onNodeWithTag("held-count", useUnmergedTree = true).assertTextEquals("3")
        shot("h6-held-badge-grid")
        rule.onNodeWithTag("held-open").performClick(); rule.waitForIdle()
        rule.onNodeWithTag("held-sheet").assertIsDisplayed()
        shot("h7-held-list-from-grid")
    }
}
