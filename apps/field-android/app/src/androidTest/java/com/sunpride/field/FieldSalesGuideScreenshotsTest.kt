package com.sunpride.field

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.storage.CallSheetProduct
import com.sunpride.field.storage.EncryptedFieldDatabase
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.RoomFieldStore
import com.sunpride.field.storage.ScopedSnapshot
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.AccountGlyph
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.StatusPill
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.TodayScreen
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.customers.CustomerRecord
import com.sunpride.field.ui.customers.CustomerTask
import com.sunpride.field.ui.customers.PlannedCall
import com.sunpride.field.ui.diagnosticvisit.CallSheetDraftLine
import com.sunpride.field.ui.diagnosticvisit.CallSheetPayload
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import com.sunpride.field.ui.syncstatus.SyncStatus
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/**
 * QSR-016: drives the real field app through a seller's day with fictional Cebu sample data and
 * captures the screens used in `docs/guides/FIELD_SALES_USER_GUIDE.md`. The assertions run in every
 * connected suite; screenshots are only transferred with `-Pandroid.testInstrumentationRunnerArguments.calmScreenshots=true`
 * and `apps/field-android/scripts/receive-screenshots.py` listening (see the guide's "Refreshing screenshots").
 */
@RunWith(AndroidJUnit4::class)
class FieldSalesGuideScreenshotsTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val environment = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")
    private val identity = StoreScope("guide|${UUID.randomUUID()}", "guide-device", "guide-scope")
    private val alias = "field-guide-screenshots"
    private val context get() = rule.activity
    private fun scoped() = RoomFieldStore(EncryptedFieldDatabase.open(context), identity)

    // Fictional sample outlets around Cebu City (not client data).
    private val stops = listOf(
        VisitDisplay("Mabolo Sari-Sari Store", "Planned", "Scheduled", "o-101", "p-101", listOf("sell"), sequence = 1,
            outletCode = "OUT-CEB-0101", customerCode = "CUST-20411", address = "12 Pope John Paul II Ave, Mabolo, Cebu City",
            latitude = 10.3187, longitude = 123.9107),
        VisitDisplay("Carbon Market Stall 14", "Planned", "Scheduled", "o-102", "p-102", listOf("sell", "collect"), sequence = 2,
            outletCode = "OUT-CEB-0102", customerCode = "CUST-20412", address = "Carbon Public Market, Cebu City",
            latitude = 10.2925, longitude = 123.8995),
        VisitDisplay("Lahug Mini Mart", "Planned", "Scheduled", "o-103", "p-103", listOf("merchandise"), sequence = 3,
            outletCode = "OUT-CEB-0103", customerCode = "CUST-20413", address = "Gorordo Ave, Lahug, Cebu City",
            latitude = 10.3305, longitude = 123.8990))
    private val today = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).toString()
    private val tomorrow = java.time.LocalDate.parse(today).plusDays(1).toString()
    private val account = CallSheetHeader("Mabolo Sari-Sari Store", "12 Pope John Paul II Ave, Mabolo, Cebu City",
        "Store owner", "0917 555 0101", "Route seller", null, "Cebu distributor", "Mon / Thu", null, "SRP")
    private val customers = stops.map { v ->
        CustomerRecord(v.outletId, v.outlet, v.outletCode, v.customerCode, v.address, v.latitude, v.longitude,
            "route-ceb-07", "CEB-07", if (v.outletId == "o-101") account else null,
            listOf(PlannedCall(today, v.plannedVisitId!!, v.intents), PlannedCall(tomorrow, "${v.plannedVisitId}-b", v.intents)),
            emptyList(), v)
    }
    private val sheet = CallSheet("o-101", 1, account, listOf(
        CallSheetProduct("prod-1", "SP-1001", "Sunpride Corned Beef 150 g", "CAN", null, "₱42.00"),
        CallSheetProduct("prod-2", "SP-1002", "Sunpride Luncheon Meat 340 g", "CAN", null, "₱98.00"),
        CallSheetProduct("prod-3", "SP-1003", "Sunpride Meat Loaf 150 g", "CAN", null, "₱36.00")))
    private val cebu = object : VisitLocation {
        override val requiresPermission = false
        override suspend fun fix(): JSONObject? = JSONObject().put("latitude", 10.3157).put("longitude", 123.8854)
            .put("accuracyMeters", 12).put("fixTime", System.currentTimeMillis()).put("provider", "fused")
            .put("mockSignal", false)
    }

    /** Real encrypted store for visit rows; [status] overrides the sync projection for the sync-state screens. */
    private inner class Backend(private val enrollment: EnrollmentState = EnrollmentState.Ready("guide-device"),
        private val status: SyncStatus? = null, private val signedIn: Boolean = true) : FieldBackend {
        override val isSignedIn get() = signedIn
        override val cachedDeviceId: String? get() = if (signedIn && enrollment !is EnrollmentState.Unregistered) identity.deviceId else null
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(context, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = enrollment
        private fun pending() = visitStates().count { it.second == "pending" }
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(stops,
            lastSynced = System.currentTimeMillis() - 1_800_000, stale = false, queuedCount = pending(),
            syncStatus = status ?: SyncStatus(queued = pending(), health = "synced",
                lastSuccess = System.currentTimeMillis() - 1_800_000,
                leaseExpiresAt = com.sunpride.field.ui.syncstatus.dayCloseFor(System.currentTimeMillis()),
                cacheExpiresAt = System.currentTimeMillis() + 86_400_000),
            customers = customers, tasks = listOf(CustomerTask("price_check", true)))
        override fun visitStates(): List<Pair<IntentRow, String>> {
            val store = scoped()
            return try { runBlocking { store.history().map { it.first to it.second.state } } } finally { store.close() }
        }
        override fun callSheet(outletId: String): CallSheet? {
            val store = scoped()
            return try { runBlocking { store.callSheet(outletId) } } finally { store.close() }
        }
        override fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
            outletId: String, drafts: List<CallSheetDraftLine>) {
            val store = scoped()
            try { runBlocking {
                val saved = store.callSheet(outletId) ?: error("No call sheet")
                store.enqueue(VisitIntentFactory.create(identity, "visit.activity", clientVisitId, checkInRequestId,
                    previousRequestId, null, outletId, emptyList(), null, null, null, null, null,
                    callSheet = CallSheetPayload.activity(saved, drafts)), System.currentTimeMillis())
            } } finally { store.close() }
        }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) {
            val store = scoped()
            try { runBlocking {
                store.enqueue(VisitIntentFactory.create(identity, kind, clientVisitId, checkInRequestId,
                    previousRequestId, plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode,
                    location), System.currentTimeMillis())
            } } finally { store.close() }
        }
    }

    private fun seed() {
        val store = scoped()
        try { runBlocking {
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"guide\"}", null, emptyList(), emptyList(), emptyList(),
                emptyList(), listOf(sheet))), "cursor", System.currentTimeMillis() + 3_600_000,
                System.currentTimeMillis() + 3_600_000)
        } } finally { store.close() }
    }

    private fun launch(backend: Backend) = rule.setContent {
        FieldApp(environment, dark = false, debug = true, backend = backend, visitLocation = cebu)
    }

    private fun shot(name: String) {
        rule.runOnUiThread {
            androidx.core.view.WindowCompat.getInsetsController(rule.activity.window,
                rule.activity.window.decorView).isAppearanceLightStatusBars = true
        }
        rule.waitForIdle()
        Thread.sleep(400)
        captureCalmScreenshot("guide-$name")
    }

    private fun waitTag(tag: String) = rule.waitUntil(10_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun waitEnabled(tag: String) =
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag(tag).assertIsEnabled() }.isSuccess }

    @After fun cleanup() { KeystoreDeviceKey.delete(alias) }

    @Test fun signInScreen() {
        launch(Backend(signedIn = false))
        waitTag("sign-in")
        rule.onNodeWithTag("shell-title").assertTextContains("Sign in")
        shot("01-sign-in")
    }

    @Test fun registerPhoneScreen() {
        launch(Backend(EnrollmentState.Unregistered))
        waitTag("key-fingerprint")
        rule.onNodeWithTag("enrollment-title").assertTextContains("Register phone")
        shot("02-register-phone")
    }

    /** Day start → route → customer → Start → call sheet order → End → sync status, all offline. */
    @Test fun sellerDay() {
        seed()
        val backend = Backend()
        launch(backend)
        waitTag("today-title")
        waitTag("route-open")
        rule.onNodeWithTag("sync-status").assertTextContains("All synced")
        shot("03-today")

        rule.onNodeWithTag("route-open").performClick()
        waitTag("route-title")
        rule.onAllNodesWithTag("route-stop-summary")[0].assertTextContains("Mabolo Sari-Sari Store", substring = true)
        rule.waitUntil(10_000) { runCatching { rule.onAllNodesWithTag("route-stop-summary")[0]
            .assertTextContains("km", substring = true) }.isSuccess }
        shot("04-route")
        rule.onNodeWithTag("route-back").performClick()

        rule.onNodeWithTag("customers-open").performScrollTo().performClick()
        waitTag("customer-search")
        rule.onNodeWithTag("customer-search").performTextInput("mabolo")
        rule.onAllNodesWithTag("customer-result")[0].assertTextContains("Mabolo", substring = true)
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        shot("05-customer-search")
        rule.onAllNodesWithTag("customer-result")[0].performClick()
        waitTag("customer-header")
        rule.onNodeWithTag("customer-header").assertTextContains("OUT-CEB-0101", substring = true)
        shot("06-outlet")
        rule.onNodeWithTag("customer-back").performClick()
        rule.onNodeWithTag("customers-back").performClick()

        waitTag("diagnostic-open")
        rule.onAllNodesWithTag("diagnostic-open")[0].performClick()
        waitEnabled("diagnostic-checkin")
        rule.onNodeWithText("Planned · Not started").assertExists()
        shot("07-visit-before-start")
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 1 }
        waitTag("call-sheet-open")
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("sync-status").assertTextContains("Sync before 10 PM") }.isSuccess }
        shot("08-visit-in-progress")

        rule.onNodeWithTag("call-sheet-open").performScrollTo().performClick()
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-prod-1-order"))
        waitEnabled("call-sheet-prod-1-order")
        rule.onNodeWithTag("call-sheet-prod-1-order").performTextInput("24")
        rule.onNodeWithTag("call-sheet-prod-1-beginningInventory").performTextInput("6")
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-prod-2-order"))
        rule.onNodeWithTag("call-sheet-prod-2-order").performTextInput("12")
        rule.onNodeWithTag("call-sheet-prod-2-beginningInventory").performTextInput("2")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-prod-1-order"))
        shot("09-call-sheet-order")
        rule.onNodeWithTag("call-sheet-save").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { backend.visitStates().count { it.first.kind == "visit.activity" } == 1 }
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-status"))
        rule.onNodeWithTag("call-sheet-status").assertTextContains("Queued", substring = true)
        shot("10-call-sheet-saved")
        val lines = JSONObject(backend.visitStates().last().first.serializedOperation)
            .getJSONObject("payload").getJSONObject("activity").getJSONArray("lines")
        assertEquals(2, lines.length())
        assertEquals(24, lines.getJSONObject(0).getInt("order"))
        rule.onNodeWithTag("visit-back").performClick()

        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick() // Completed
        waitEnabled("diagnostic-checkout")
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        waitTag("diagnostic-confirm-end")
        rule.onNodeWithTag("end-review").performScrollTo()
        shot("11-end-review")
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        rule.waitUntil(10_000) { backend.visitStates().any { it.first.kind == "visit.checkOut" } }
        waitTag("visit-result")
        rule.onNodeWithTag("result-sync").performScrollTo().assertTextContains("Waiting to send", substring = true)
        rule.onNodeWithTag("visit-result").performScrollTo()
        shot("12-visit-done")
        rule.onNodeWithTag("visit-back").performClick()

        waitTag("today-title")
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("sync-status").assertTextContains("Sync before 10 PM") }.isSuccess }
        shot("13-today-waiting")
        rule.onNodeWithTag("sync-status").performClick()
        waitTag("sync-now")
        rule.onNodeWithText("Waiting").assertExists()
        shot("14-sync-waiting")
    }

    private fun syncState(status: SyncStatus, pill: String, name: String) {
        launch(Backend(status = status))
        waitTag("today-title")
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("sync-status").assertTextContains(pill) }.isSuccess }
        rule.onNodeWithTag("sync-status").performClick()
        waitTag("sync-now")
        shot(name)
    }

    private val now get() = System.currentTimeMillis()

    @Test fun needsReviewState() = syncState(SyncStatus(review = 1, health = "synced", lastSuccess = now - 600_000,
        leaseExpiresAt = now + 3_600_000, cacheExpiresAt = now + 3_600_000,
        reviewReasons = listOf(SyncStatus.plainReason("mcp_order"))), "Needs review · not synced", "15-sync-needs-review")

    @Test fun lateState() = syncState(SyncStatus(queued = 3, health = "synced", lastSuccess = now - 14 * 3_600_000L,
        leaseExpiresAt = now + 3_600_000, cacheExpiresAt = now + 3_600_000, earliestUnsentCloseAt = now - 60_000),
        "Late · held for review", "16-sync-late")

    @Test fun heldState() = syncState(SyncStatus(held = 2, health = "held_for_review", lastSuccess = now - 3_600_000,
        leaseExpiresAt = now + 3_600_000, cacheExpiresAt = now + 3_600_000), "Held · needs review", "17-sync-held")

    @Test fun dayClosedState() = syncState(SyncStatus(health = "synced", lastSuccess = now - 86_400_000,
        leaseExpiresAt = now - 60_000, cacheExpiresAt = now + 3_600_000), "Day closed · sync for access", "18-sync-day-closed")

    @Test fun phoneRemovedScreen() {
        launch(Backend(EnrollmentState.Removed, status = SyncStatus(queued = 2)))
        waitTag("enrollment-title")
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("enrollment-title").assertTextContains("Phone removed") }.isSuccess }
        shot("19-phone-removed")
    }

    @Test fun supportInfoScreen() {
        launch(Backend())
        waitTag("account-open")
        rule.onNodeWithTag("account-open").performClick()
        waitTag("support-info")
        rule.onNodeWithTag("support-info").performClick()
        waitTag("support-copy")
        shot("20-support-info")
    }

    /**
     * The no-signal label depends on the phone's real connectivity, so this frame composes the app's own
     * top bar pill and Today screen with `offline = true` instead of toggling the shared emulator's network.
     */
    @Test fun offlineToday() {
        val status = SyncStatus(health = "synced", lastSuccess = now - 1_800_000, leaseExpiresAt = now + 3_600_000,
            cacheExpiresAt = now + 3_600_000, offline = true)
        rule.setContent {
            MaterialTheme(colorScheme = SunprideTokens.lightColors, shapes = SunprideTokens.shapes,
                typography = SunprideTokens.typography) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column {
                        Surface(color = MaterialTheme.colorScheme.surface, modifier = Modifier.statusBarsPadding()) {
                            Column {
                                Row(Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 20.dp),
                                    horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                    Text("Sunpride Field", style = MaterialTheme.typography.titleMedium)
                                    AccountGlyph()
                                }
                                StatusPill(status.label(now), Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp)
                                    .then(Modifier))
                            }
                        }
                        Box(Modifier.weight(1f)) {
                            TodayScreen(TodayData(stops, stale = true, syncStatus = status, customers = customers),
                                false, {}, {}, offline = true, onRoute = {}, onCustomers = {})
                        }
                    }
                }
            }
        }
        rule.onNodeWithText("Offline · saved data").assertExists()
        shot("21-today-offline")
    }
}
