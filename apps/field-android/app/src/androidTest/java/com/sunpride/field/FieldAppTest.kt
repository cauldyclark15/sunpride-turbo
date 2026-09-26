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
        override val isSignedIn get() = signedIn
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            if (sync) syncs++
            return TodayData(lastSynced = if (sync) 150L else null, stale = !sync)
        }
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) { signInError?.let { throw it }; signedIn = true }
        override fun signOut() { signedIn = false }
        override fun refreshEnrollment(signer: DeviceSigner) = enrollment
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
