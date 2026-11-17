package com.sunpride.field.sell

import android.graphics.Bitmap
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.WorkManager
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.sell.auth.SellAccess
import com.sunpride.field.sell.ui.Page
import com.sunpride.field.storage.EncryptedFieldDatabase
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.TodayData
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.File

/**
 * SP-0192 on an emulator I start myself (720x1440, never a physical phone): the real Field app shell with a fake Field
 * backend, and the Sell area on PRACTICE data (the Van app's fixture backend; no network, no office, test printer).
 * Screenshots land in the app's external files under `sell-shots/` (pulled into the lane's evidence folder).
 */
class SellAreaDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "sp192-sell-test"
    private var built = 0
    private val hosts = mutableListOf<SellHost>()

    private val access = object : SellAccess {
        override val siteUrl = "https://practice.invalid"
        override val ready = true
        override val isSignedIn = true
        override fun sessionKey() = "practice"
        override fun accessToken(refresh: Boolean): String = error("practice data never goes to the office")
        override fun invalidateAccessToken() {}
        override fun deviceId() = "stub-van-device"
        override fun signer(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(context, alias)
        override fun deviceKeyId(): String? = null
    }

    private inner class Backend(private val selling: Boolean) : FieldBackend {
        var accessAsked = 0
        override val isSignedIn = true
        override val cachedDeviceId = "stub-van-device"
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(context, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready("stub-van-device")
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(lastSynced = System.currentTimeMillis(), stale = false)
        override fun sellingEnabled() = selling
        override fun sellAccess(): SellAccess { accessAsked++; return access }
    }

    private fun factory(): (android.content.Context, SellAccess) -> SellHost = { ctx, a ->
        built++
        SellHost.create(ctx, a, stub = true, printer = com.sunpride.field.sell.printing.FakeReceiptPrinter()).also { hosts += it }
    }

    @Before fun practiceDataOnly() {
        WorkManager.getInstance(context).cancelUniqueWork("field-sell-sync-stub").result.get()
        context.getSharedPreferences("van_fixture_backend", 0).edit().clear().commit()
        context.getSharedPreferences("sell_stub_identity_index", 0).edit().clear().commit()
        // Only the practice partition's selling rows; nothing else in the Field database is touched.
        val db = EncryptedFieldDatabase.shared(context).openHelper.writableDatabase
        com.sunpride.field.storage.SellMigration.CREATE_SQL.mapNotNull { Regex("^CREATE TABLE IF NOT EXISTS `(sell_[a-z_]+)`").find(it)?.groupValues?.get(1) }
            .forEach { db.execSQL("DELETE FROM `$it` WHERE fullAuthSubject LIKE 'https://fixture.invalid|%'") }
    }
    @After fun cleanup() { hosts.forEach { it.close() }; KeystoreDeviceKey.delete(alias) }

    private fun shot(name: String) {
        rule.waitForIdle()
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        Thread.sleep(400)
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        var bmp: Bitmap? = null
        repeat(5) { if (bmp == null) bmp = automation.takeScreenshot() ?: run { Thread.sleep(250); null } }
        val dir = File(checkNotNull(context.getExternalFilesDir(null)), "sell-shots").also { it.mkdirs() }
        File(dir, "$name.png").outputStream().use { checkNotNull(bmp).compress(Bitmap.CompressFormat.PNG, 100, it) }
    }

    private fun mount(selling: Boolean): Backend {
        val backend = Backend(selling)
        rule.setContent { FieldApp(AppEnvironment("https://practice.invalid"), dark = false, backend = backend, sellHostFactory = factory()) }
        rule.waitUntil(20_000) { rule.onAllNodesWithTag("nav-today").fetchSemanticsNodes().isNotEmpty() }
        return backend
    }

    @Test fun nonSellerHasNoSellTabAndNoSellingWork() {
        val backend = mount(selling = false)
        rule.onNodeWithTag("nav-today").assertIsDisplayed()
        rule.onAllNodesWithTag("nav-sell").assertCountEquals(0)
        shot("01-non-seller-today")
        assertEquals("no Sell area is built for a person without Selling", 0, built)
        assertEquals("the Field app never lends its session to selling", 0, backend.accessAsked)
        assertEquals(null, SellHost.active)
    }

    @Test fun sellerSellsAndPrintsTheReceipt() {
        mount(selling = true)
        rule.onNodeWithTag("nav-sell").assertIsDisplayed()
        shot("02-seller-today-with-sell-tab")
        rule.onNodeWithTag("nav-sell").performClick()
        rule.waitUntil(20_000) { hosts.singleOrNull()?.controller?.let { it.initialized && !it.busy && it.trip != null && it.products.isNotEmpty() && it.policy != null } == true }
        val c = hosts.single().controller
        assertEquals(1, built)
        rule.onNodeWithTag("sell-area").assertIsDisplayed()
        rule.onNodeWithTag("sell-tabs").assertIsDisplayed()
        shot("03-sell-trip")
        // Load and start the trip (the Van app's own steps), then sell.
        rule.runOnUiThread { c.open(Page.LOAD) }; rule.waitForIdle()
        shot("04-sell-check-load")
        rule.onNodeWithTag("confirm-load").performClick()
        rule.waitUntil(10_000) { c.load?.confirmPending == true && !c.busy }
        runBlocking { c.repository.syncNow() }; rule.waitUntil(10_000) { c.trip?.status == "loaded" }
        rule.runOnUiThread { c.open(Page.START) }; rule.waitForIdle()
        rule.onNodeWithTag("confirm-truck").performClick(); rule.onNodeWithTag("confirm-route").performClick()
        "2000".forEach { rule.onNodeWithTag("float-key-$it").performScrollTo().performClick() }
        shot("05-sell-start-trip")
        rule.onNodeWithTag("start-trip").performClick()
        rule.waitUntil(10_000) { c.trip?.startPending == true && !c.busy }
        runBlocking { c.repository.syncNow() }; rule.waitUntil(10_000) { c.trip?.status == "active" }
        rule.runOnUiThread { c.open(Page.HOME) }; rule.waitForIdle()
        shot("06-sell-trip-active")
        rule.onNodeWithTag("sell-tab-sell").performClick(); rule.waitForIdle()
        shot("07-sell-customers")
        rule.runOnUiThread { c.startSale(c.customers.first { it.source == "route" }) }
        rule.waitUntil(10_000) { c.page == Page.SALE && c.retailLoaded }
        rule.runOnUiThread { c.addToSale(c.products.first().productId, 2) }; rule.waitForIdle()
        shot("08-sell-grid-cart")
        rule.onNodeWithTag("checkout").performClick()
        rule.waitUntil(10_000) { c.page == Page.CHECKOUT }
        rule.waitForIdle()
        // Taking money: the Field bar and the Sell row both step aside.
        rule.onAllNodesWithTag("nav-sell").assertCountEquals(0)
        rule.onAllNodesWithTag("sell-tabs").assertCountEquals(0)
        rule.onNodeWithTag("pay-exact").performClick(); rule.waitForIdle()
        shot("09-sell-payment-exact")
        rule.onNodeWithTag("complete-sale").performClick()
        rule.waitUntil(10_000) { c.page == Page.SALE_DONE }
        rule.waitUntil(10_000) { !c.printing }
        shot("10-sell-sale-complete-printed")
        assertTrue("the receipt went to the (test) printer", c.lastPrint != null || c.printQuestionSaleId != null)
        rule.runOnUiThread { c.answerPrinted() }; rule.waitForIdle()
        for ((page, name) in listOf(Page.RECEIPTS to "11-sell-receipts", Page.CASH to "12-sell-count-cash", Page.STOCK_COUNT to "13-sell-count-stock", Page.CLOSE_TRIP to "14-sell-close-trip", Page.MORE to "15-sell-more")) {
            rule.runOnUiThread { c.open(page) }; rule.waitForIdle(); shot(name)
        }
        assertEquals(1, c.savedSales.size)
    }
}
