package com.sunpride.field

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.Density
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.device.fingerprint
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.TodayScreen
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay
import org.junit.After
import org.junit.Rule
import org.junit.Test

class FieldAppTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val configured = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")
    private val alias = "sunpride-field-device-ui-test"

    /** Real Keystore key, scripted server answers; no network, no real account. */
    private inner class ScriptedBackend(var enrollment: EnrollmentState, val signInError: AuthFailure? = null) : FieldBackend {
        var signedIn = false
        var syncs = 0
        var visits: List<VisitDisplay> = emptyList()
        var customers: List<com.sunpride.field.ui.customers.CustomerRecord> = emptyList()
        override val isSignedIn get() = signedIn
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            if (sync) syncs++
            return TodayData(visits, lastSynced = if (sync) 150L else null, stale = !sync, customers = customers,
                supervisor = supervisor)
        }
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) { signInError?.let { throw it }; signedIn = true }
        override fun signOut() { signedIn = false }
        override fun refreshEnrollment(signer: DeviceSigner) = enrollment
        var supervisor = false
        var teamCalls = 0
        override fun team(directOnly: Boolean): com.sunpride.field.ui.team.TeamView {
            teamCalls++
            return com.sunpride.field.ui.team.TeamView(com.sunpride.field.ui.team.TeamSummary("2026-09-28", 1L,
                Long.MAX_VALUE, directOnly, false, listOf(com.sunpride.field.ui.team.TeamPerson("p1", "Ana Cruz",
                    "Route Salesman", "PMOT", true, 3, 1, 1, 1, 0, 0, true, 0, 0, 0, 1L, null, 1L)),
                0, 0, emptyList()))
        }
    }

    @After fun cleanUp() = KeystoreDeviceKey.delete(alias)

    @Test fun signInIsEnabledOnceCredentialsAreEnteredWithoutPrematureSyncPill() {
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertDoesNotExist()
        rule.onNodeWithTag("sign-in").assertIsNotEnabled()
        rule.onNodeWithTag("email").performTextInput("seller@example.test")
        rule.onNodeWithTag("password").performTextInput("fake-password")
        rule.onNodeWithTag("sign-in").assertIsEnabled()
    }

    @Test fun unregisteredPhoneShowsCopyableKeyFingerprintAndDeviceInfo() {
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("email").performTextInput("seller@example.test")
        rule.onNodeWithTag("password").performTextInput("fake-password")
        rule.onNodeWithTag("sign-in").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("show-full-code") }
        rule.onNodeWithTag("show-full-code").performClick()
        val signer = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        rule.onNodeWithTag("enrollment-title").assertTextContains("Register phone")
        rule.onNodeWithTag("sync-status").assertDoesNotExist()
        rule.onNodeWithTag("public-key").assertTextContains(signer.publicKeyBase64)
        rule.onNodeWithTag("key-fingerprint").assertTextContains(fingerprint(signer.publicKeySpki).replace(":", "").chunked(4).joinToString(" "), substring = true)
        rule.onNodeWithTag("copy-key").assertIsEnabled()
        rule.onNodeWithTag("check-again").assertIsEnabled()
        rule.onNodeWithTag("account-open").performClick()
        rule.onNodeWithTag("device-info").assertExists()
        rule.onNodeWithTag("account-title").assertIsDisplayed()
        rule.onNodeWithTag("support-info").performClick()
        rule.onNodeWithTag("support-back").assertIsDisplayed()
        rule.onNodeWithText("Done").assertDoesNotExist()
        rule.onNodeWithTag("support-back").performClick()
        rule.onNodeWithTag("account-title").assertIsDisplayed()
    }

    @Test fun registrationPollTriggersBootstrapWithoutSyncTap() {
        val backend = ScriptedBackend(EnrollmentState.Unregistered)
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend) }
        rule.onNodeWithTag("email").performTextInput("seller@example.test")
        rule.onNodeWithTag("password").performTextInput("fake-password")
        rule.onNodeWithTag("sign-in").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("check-again") }
        backend.enrollment = EnrollmentState.Ready("dev1")
        rule.mainClock.advanceTimeBy(com.sunpride.field.auth.Enrollment.POLL_INTERVAL_MS + 100L)
        rule.waitUntil(10_000) { backend.syncs == 1 }
        rule.onNodeWithTag("sync-status").assertExists()
        rule.onNodeWithTag("sync-status").performClick()
        rule.onNodeWithTag("sync-back").assertExists()
    }

    @Test fun readyAndRemovedStates() {
        val backend = ScriptedBackend(EnrollmentState.Ready("dev1")).apply { signedIn = true }
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("today-title") }
        rule.onNodeWithTag("today-title").assertTextContains("Today")
        rule.onNodeWithTag("sync-status").assertExists()
        backend.enrollment = EnrollmentState.Removed
        rule.onNodeWithTag("account-open").performClick()
        rule.onNodeWithTag("sign-out").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("shell-title") }
    }

    @Test fun todayOpensTheDailyRouteAndBackWithoutNetworkOrLocationPrompt() {
        val backend = ScriptedBackend(EnrollmentState.Ready("dev1")).apply {
            signedIn = true
            visits = listOf(VisitDisplay("Second Store", "Planned", "Scheduled", "o2", "p2", sequence = 2),
                VisitDisplay("First Store", "Planned", "Scheduled", "o1", "p1", sequence = 1, address = "1 Rizal Ave"))
        }
        val noFix = object : com.sunpride.field.ui.diagnosticvisit.VisitLocation {
            override val requiresPermission = false
            override suspend fun fix(): org.json.JSONObject? = null
        }
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend, visitLocation = noFix) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("route-open") }
        rule.onNodeWithTag("route-open").assertTextContains("Next: First Store", substring = true).performClick()
        rule.onNodeWithTag("route-title").assertTextContains("Route")
        rule.onNodeWithTag("route-summary").assertTextContains("0 of 2 done")
        rule.onNodeWithTag("route-back").performClick()
        rule.onNodeWithTag("today-title").assertIsDisplayed()
    }

    @Test fun todayOpensCustomerSearchThenOutletDetailAndBackOffline() {
        val backend = ScriptedBackend(EnrollmentState.Ready("dev1")).apply {
            signedIn = true
            customers = listOf(com.sunpride.field.ui.customers.CustomerRecord("o1", "First Store", "OUT-1"),
                com.sunpride.field.ui.customers.CustomerRecord("o2", "Second Store", "OUT-2", address = "2 Mabini St"))
        }
        rule.setContent { FieldApp(configured, dark = false, debug = false, backend = backend) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("customers-open") }
        rule.onNodeWithTag("customers-open").performClick()
        rule.onNodeWithTag("customers-title").assertTextContains("Customers")
        rule.onNodeWithTag("customer-search").performTextInput("mabini")
        rule.onNodeWithTag("customer-result").assertTextContains("Second Store", substring = true).performClick()
        rule.onNodeWithTag("customer-title").assertTextContains("Outlet")
        rule.onNodeWithTag("customer-header").assertTextContains("Second Store", substring = true)
        rule.onNodeWithTag("customer-visit").assertDoesNotExist() // visit recording is debug-only
        rule.onNodeWithTag("customer-back").performClick()
        rule.onNodeWithTag("customers-title").assertIsDisplayed()
        rule.onNodeWithTag("customers-back").performClick()
        rule.onNodeWithTag("today-title").assertIsDisplayed()
    }

    @Test fun supervisorOpensTeamFromTodayAndFieldSalesDoesNotSeeIt() {
        val backend = ScriptedBackend(EnrollmentState.Ready("dev1")).apply { signedIn = true; supervisor = true }
        var show by androidx.compose.runtime.mutableStateOf(true)
        rule.setContent { if (show) FieldApp(configured, dark = false, debug = false, backend = backend) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("team-open") }
        rule.onNodeWithTag("team-open").performClick()
        rule.onNodeWithTag("team-title").assertTextContains("Team")
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("team-person") }
        rule.onNodeWithTag("team-person").assertTextContains("Ana Cruz", substring = true)
            .assertTextContains("In a call", substring = true)
        rule.onNodeWithTag("team-back").performClick()
        rule.onNodeWithTag("today-title").assertIsDisplayed()
        assert(backend.teamCalls >= 1)
        backend.supervisor = false
        show = false; rule.waitForIdle(); show = true
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("today-title") }
        rule.waitForIdle()
        rule.onNodeWithTag("team-open").assertDoesNotExist()
    }

    @Test fun revokedPhoneShowsRemoved() {
        val backend = ScriptedBackend(EnrollmentState.Removed).apply { signedIn = true }
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend) }
        rule.waitUntil(10_000) {
            runCatching { rule.onNodeWithTag("enrollment-title").assertTextContains("Phone removed") }.isSuccess
        }
        rule.onNodeWithTag("sync-status").assertDoesNotExist()
    }

    @Test fun todayRendersSavedVisitsAndStaleState() {
        rule.setContent {
            TodayScreen(TodayData(listOf(VisitDisplay("Outlet One", "Planned", "Pending")),
                1790380800000L, stale = true, warning = "Offline verification pending"), false, {}, {})
        }
        rule.onNodeWithTag("today-title").assertTextContains("Today")
        rule.onNodeWithTag("today-visit").assertTextContains("Outlet One", substring = true)
        rule.onNodeWithTag("today-stale").assertDoesNotExist()
        rule.onNodeWithTag("sync-now").assertDoesNotExist()
    }

    @Test fun todayDashboardShowsProgressNextStoreSalesAndRouteOrder() {
        var opened: VisitDisplay? = null
        rule.setContent {
            TodayScreen(TodayData(listOf(
                VisitDisplay("Third Mart", "Planned", "Scheduled", "o3", "p3", sequence = 2),
                VisitDisplay("First Store", "Planned", "Done", "o1", "p1", sequence = 0,
                    callFacts = com.sunpride.field.storage.ProductiveCall.facts(listOf("order_intent"), null)),
                VisitDisplay("Second Shop", "Planned", "In progress", "o2", "p2", sequence = 1)),
                stale = false, routeCode = "R-07", sales = com.sunpride.field.ui.today.DaySalesView(
                    com.sunpride.field.ui.today.DaySales("2026-10-05", 2_500_000, 1_000_050, 40, null, 1_000_050, null),
                    savedAt = 1L)), false, {}, {}, onVisit = { opened = it }, diagnosticEnabled = true)
        }
        rule.onNodeWithTag("today-calls").assertTextContains("1 of 3")
        rule.onNodeWithTag("today-productive").assertTextContains("Productive 1 of 1 finished · 100%")
        rule.onNodeWithTag("today-next").assertExists()
        rule.onNodeWithText("CURRENT CALL").assertExists()
        rule.onNodeWithTag("today-next-store").assertTextContains("Second Shop", substring = true)
            .assertTextContains("Stop 2 of 3", substring = true).performClick()
        assert(opened?.plannedVisitId == "p2")
        rule.onNodeWithTag("today-sales").performScrollTo()
        rule.onNodeWithText("₱25,000.00").assertExists()
        rule.onNodeWithText("₱10,000.50 · 40%").assertExists()
        rule.onNodeWithTag("today-sales-saved").assertExists()
        rule.onNodeWithTag("today-route").performScrollTo()
        rule.onNodeWithText("ROUTE R-07 · 3 STOPS").assertExists()
        val rows = rule.onAllNodesWithTag("diagnostic-open")
        rows[0].assertTextContains("First Store", substring = true).assertTextContains("Productive", substring = true)
        rows[1].assertTextContains("Second Shop", substring = true)
        rows[2].assertTextContains("Third Mart", substring = true)
        rule.onNodeWithTag("sync-details").assertDoesNotExist()
    }

    @Test fun todayDashboardWithoutVisitsShowsOnlyEmptyRouteAndSales() {
        rule.setContent { TodayScreen(TodayData(stale = false), false, {}, {}) }
        rule.onNodeWithTag("today-empty").assertExists()
        rule.onNodeWithTag("today-progress").assertDoesNotExist()
        rule.onNodeWithTag("today-next").assertDoesNotExist()
        rule.onNodeWithTag("today-sales").assertExists()
        rule.onNodeWithTag("today-sales-none").assertTextContains("Sync to see sales")
    }

    @Test fun todayDoesNotDuplicateSyncState() {
        val partition = com.sunpride.field.storage.PartitionRow("a", "d", "s", "g", leaseExpiresAt = Long.MAX_VALUE,
            cacheExpiresAt = Long.MAX_VALUE, syncHealth = "synced", lastSuccessfulSync = 150L)
        val pending = com.sunpride.field.ui.syncstatus.SyncStatus.fromRoom(partition,
            listOf(com.sunpride.field.storage.OutboxRow("a", "d", "s", "r", 1)))
        rule.setContent { TodayScreen(TodayData(stale = false, queuedCount = 1, syncStatus = pending), false, {}, {}) }
        rule.onNodeWithTag("today-stale").assertDoesNotExist()
        rule.onNodeWithTag("queued-count").assertDoesNotExist()
        rule.onNodeWithTag("last-synced").assertDoesNotExist()
        rule.onNodeWithTag("sync-details").assertDoesNotExist()
    }

    @Test fun wrongPasswordShowsFixedMessage() {
        rule.setContent {
            FieldApp(configured, dark = false, debug = true,
                backend = ScriptedBackend(EnrollmentState.Unregistered, AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)))
        }
        rule.onNodeWithTag("email").performTextInput("seller@example.test")
        rule.onNodeWithTag("password").performTextInput("wrong")
        rule.onNodeWithTag("sign-in").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("auth-error") }
        rule.onNodeWithTag("auth-error").assertTextContains(AuthFailure.Kind.INVALID_CREDENTIALS.message)
    }

    @Test fun designTokensPreviewIsNotReachable() {
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("design-tokens-link").assertDoesNotExist()
        rule.onNodeWithTag("design-tokens-screen").assertDoesNotExist()
    }

    @Test fun darkAtDoubleFontScaleKeepsKeyNodes() {
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                FieldApp(configured, dark = true, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered))
            }
        }
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertDoesNotExist()
        rule.onNodeWithTag("sign-in").assertExists().assertIsNotEnabled()
    }

    @Test fun missingEndpointsShowVisibleError() {
        rule.setContent { FieldApp(AppEnvironment("", ""), dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("environment-error").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertDoesNotExist()
    }

    private fun <R : org.junit.rules.TestRule, A : androidx.activity.ComponentActivity>
        androidx.compose.ui.test.junit4.AndroidComposeTestRule<R, A>.onAllNodesWithTagExists(tag: String) =
        onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
}
