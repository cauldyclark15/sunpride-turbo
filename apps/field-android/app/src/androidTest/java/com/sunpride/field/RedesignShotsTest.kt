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
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeUp
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
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.storage.VisitCallRules
import com.sunpride.field.storage.ProductiveCall
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
private const val DAY = 86_400_000L

@RunWith(AndroidJUnit4::class)
class RedesignShotsTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val environment = AppEnvironment("https://sunpride.cauldnclark.com")
    private val identity = StoreScope("shots|${UUID.randomUUID()}", "guide-device", "shots-scope")
    private val alias = "field-redesign-shots"
    private val context get() = rule.activity
    private fun scoped() = EncryptedFieldDatabase.store(context, identity)

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
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(decorated(),
            lastSynced = System.currentTimeMillis() - 1_800_000, stale = false, queuedCount = pending(),
            syncStatus = status ?: SyncStatus(queued = pending(), health = "synced",
                lastSuccess = System.currentTimeMillis() - 1_800_000, leaseExpiresAt = close(),
                cacheExpiresAt = System.currentTimeMillis() + 86_400_000, earliestUnsentCloseAt = close()),
            customers = customers, tasks = listOf(CustomerTask("price_check", true)), supervisor = true, routeCode = "CEB-07")
        /** Same Done / In progress projection FieldController applies to Today from the phone's visit history. */
        private fun decorated(): List<VisitDisplay> {
            val history = visitStates()
            return stops.map { visit ->
                val call = VisitCallRules.related(visit.plannedVisitId, visit.outletId, today, history)
                visit.copy(status = when {
                    call.any { it.second == "review" } -> "Needs review"
                    VisitCallRules.closed(call) -> "Done"
                    VisitCallRules.started(call) -> "In progress"
                    else -> visit.status
                }, timeSpent = VisitCallRules.timeSpent(call), callFacts = ProductiveCall.factsOf(call))
            }
        }
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
        override fun orderDrafts(): List<com.sunpride.field.orders.OrderDraft> {
            val store = scoped()
            return try { runBlocking { store.orderDrafts() } } finally { store.close() }
        }
        override fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
            quantities: List<Pair<String, Int>>): com.sunpride.field.orders.OrderDraft {
            val store = scoped()
            return try { runBlocking { com.sunpride.field.ui.saveOrderDraftIn(store, draftId, clientVisitId,
                checkInRequestId, quantities, System.currentTimeMillis()) } } finally { store.close() }
        }
        override fun discardOrderDraft(draftId: String) {
            val store = scoped()
            try { runBlocking { store.discardOrderDraft(draftId) } } finally { store.close() }
        }
        override fun orderChecks(draftId: String): List<com.sunpride.field.orders.OrderCheck> {
            val store = scoped()
            return try { runBlocking { com.sunpride.field.orders.OrderSubmission.checks(store,
                store.orderDrafts().single { it.draftId == draftId }, System.currentTimeMillis()) } } finally { store.close() }
        }
        override fun submitOrderDraft(draftId: String, previousRequestId: String): com.sunpride.field.orders.OrderDraft {
            val store = scoped()
            return try { runBlocking { com.sunpride.field.orders.submitOrderDraftIn(store, identity, draftId,
                previousRequestId, System.currentTimeMillis()) } } finally { store.close() }
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
            val outlet = JSONObject().put("id", "o-101").put("name", "Mabolo Sari-Sari Store").put("routeId", "route-ceb-07")
                .put("customerId", "c-20411").put("territoryId", "t-ceb-07").put("territoryCode", "CEB-07")
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"guide\"}", null, emptyList(),
                listOf(SnapshotItem("o-101", outlet.toString())),
                listOf(SnapshotItem("c-20411", "{\"id\":\"c-20411\",\"code\":\"CUST-20411\"}")),
                emptyList(), listOf(sheet))), "cursor", System.currentTimeMillis() + 3_600_000,
                System.currentTimeMillis() + 3_600_000)
        } } finally { store.close() }
    }

    private fun launch(backend: Backend) = rule.setContent {
        FieldApp(environment, dark = false, debug = true, backend = backend, visitLocation = cebu)
    }

    private fun shot(name: String) {
        rule.waitForIdle()
        Thread.sleep(400)
        captureCalmScreenshot("shot-$name")
    }

    private fun waitTag(tag: String) = rule.waitUntil(10_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun waitEnabled(tag: String) =
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag(tag).assertIsEnabled() }.isSuccess }


    private fun close(): Long = com.sunpride.field.ui.syncstatus.dayCloseFor(System.currentTimeMillis())
        .let { if (it > System.currentTimeMillis()) it else it + DAY }
    @After fun cleanup() { KeystoreDeviceKey.delete(alias) }

    private fun has(tag: String) = rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()
    /** Scroll a Today/More list to the tag when it is inside one, then tap it. */
    private fun tap(tag: String) {
        waitTag(tag)
        runCatching { rule.onNodeWithTag(tag).performScrollTo() }
        rule.onNodeWithTag(tag).performClick()
    }
    /** Bottom-bar tab when the build has one, else the old Today link. */
    private fun goto(nav: String, legacy: String) { if (has(nav)) rule.onNodeWithTag(nav).performClick() else tap(legacy) }
    private fun openMore(tag: String) { if (has("nav-more")) { rule.onNodeWithTag("nav-more").performClick(); tap(tag) } else tap(tag) }
    private fun home() { if (has("nav-today")) rule.onNodeWithTag("nav-today").performClick() }
    private fun scrollRoot() { rule.onRoot().performTouchInput { swipeUp(startY = height * 0.6f, endY = height * 0.15f) }; rule.waitForIdle() }

    @Test fun a01_signIn() { launch(Backend(signedIn = false)); waitTag("sign-in"); shot("01-sign-in") }
    @Test fun a02_register() { launch(Backend(EnrollmentState.Unregistered)); waitTag("key-fingerprint"); shot("02-register-phone") }

    @Test fun b01_today() {
        seed(); launch(Backend()); waitTag("today-title")
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("sync-status").assertTextContains("All synced") }.isSuccess }
        shot("03-today"); scrollRoot(); shot("04-today-scrolled"); scrollRoot(); shot("05-today-bottom")
    }

    @Test fun b02_route() {
        seed(); launch(Backend()); waitTag("today-title")
        goto("nav-route", "route-open"); waitTag("route-title")
        rule.waitUntil(10_000) { runCatching { rule.onAllNodesWithTag("route-stop-summary")[0].assertTextContains("km", substring = true) }.isSuccess }
        shot("06-route"); scrollRoot(); shot("07-route-scrolled")
    }

    @Test fun b03_stores() {
        seed(); launch(Backend()); waitTag("today-title")
        goto("nav-stores", "customers-open"); waitTag("customer-search")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        shot("08-stores")
        rule.onNodeWithTag("customer-search").performTextInput("mabolo")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        shot("09-stores-search")
        rule.onAllNodesWithTag("customer-result")[0].performClick()
        waitTag("customer-header"); shot("10-store-detail"); scrollRoot(); shot("11-store-detail-scrolled")
    }

    @Test fun b04_visit() {
        seed(); val backend = Backend(); launch(backend); waitTag("today-title")
        waitTag("diagnostic-open"); runCatching { rule.onAllNodesWithTag("diagnostic-open")[0].performScrollTo() }
        rule.onAllNodesWithTag("diagnostic-open")[0].performClick()
        waitEnabled("diagnostic-checkin"); shot("12-visit-before-start")
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 1 }
        waitTag("call-sheet-open"); shot("13-visit-in-progress"); scrollRoot(); shot("14-visit-in-progress-2")
        rule.onNodeWithTag("call-sheet-open").performScrollTo().performClick()
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-prod-1-order"))
        waitEnabled("call-sheet-prod-1-order")
        rule.onNodeWithTag("call-sheet-prod-1-order").performTextInput("24")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        shot("15-call-sheet")
        rule.onNodeWithTag("call-sheet-save").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { backend.visitStates().count { it.first.kind == "visit.activity" } == 1 }
        rule.onNodeWithTag("visit-back").performClick()
        waitTag("order-new"); rule.onNodeWithTag("order-new").performScrollTo().performClick()
        waitTag("order-title")
        rule.onNodeWithTag("order-products").performScrollToNode(hasTestTag("order-qty-prod-1"))
        rule.onNodeWithTag("order-qty-prod-1").performTextInput("24")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        shot("16-order-new")
        rule.onNodeWithTag("order-save").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { backend.orderDrafts().size == 1 }
        waitTag("order-review"); shot("17-order-saved")
        rule.onNodeWithTag("visit-back").performClick()
        waitTag("order-draft"); rule.onNodeWithTag("order-draft").performScrollTo().performClick()
        waitTag("order-review"); rule.onNodeWithTag("order-review").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("order-check-ok").fetchSemanticsNodes().size == 5 }
        shot("18-order-review")
        rule.onNodeWithTag("order-submit").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("order-status").assertTextContains("Waiting to send") }.isSuccess }
        shot("18b-order-sent")
        rule.onNodeWithTag("visit-back").performClick()
        waitTag("order-sent")
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick()
        waitEnabled("diagnostic-checkout"); rule.onNodeWithTag("diagnostic-checkout").performClick()
        waitTag("diagnostic-confirm-end"); shot("19-end-call")
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        waitTag("visit-result"); shot("20-visit-done")
        rule.onNodeWithTag("visit-back").performClick()
        waitTag("today-title")
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("today-calls").assertTextContains("1 of 3") }.isSuccess }
        shot("21-today-after-call")
    }

    @Test fun b05_syncAndAccount() {
        seed(); launch(Backend()); waitTag("today-title")
        rule.onNodeWithTag("sync-status").performClick(); waitTag("sync-now"); shot("22-sync")
        rule.onNodeWithTag("sync-back").takeIf { has("sync-back") }?.performClick() ?: home()
        waitTag("account-open"); rule.onNodeWithTag("account-open").performClick()
        waitTag("support-info"); shot("23-account"); scrollRoot(); shot("24-account-2")
        tap("support-info"); waitTag("support-copy"); shot("25-support")
    }

    @Test fun b06_more() {
        seed(); launch(Backend()); waitTag("today-title")
        if (has("nav-more")) { rule.onNodeWithTag("nav-more").performClick(); rule.waitForIdle(); shot("26-more"); scrollRoot(); shot("27-more-2") }
        if (has("nav-messages")) { rule.onNodeWithTag("nav-messages").performClick(); rule.waitForIdle(); Thread.sleep(1500); shot("28-messages") }
        else { tap("messages-open"); rule.waitForIdle(); Thread.sleep(1500); shot("28-messages") }
    }

    @Test fun b07_tools() {
        seed(); launch(Backend()); waitTag("today-title")
        openMore("catalogue-open"); rule.waitForIdle(); Thread.sleep(800); shot("29-catalogue")
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; rule.waitForIdle()
        openMore("census-open"); rule.waitForIdle(); Thread.sleep(800); shot("30-census")
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; rule.waitForIdle()
        openMore("workforce-open"); rule.waitForIdle(); Thread.sleep(800); shot("31-attendance")
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; rule.waitForIdle()
        openMore("collections-open"); rule.waitForIdle(); Thread.sleep(800); shot("32-collections")
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; rule.waitForIdle()
        openMore("jointcall-open"); rule.waitForIdle(); Thread.sleep(800); shot("33-workwith")
        rule.activityRule.scenario.onActivity { it.onBackPressedDispatcher.onBackPressed() }; rule.waitForIdle()
    }
}
