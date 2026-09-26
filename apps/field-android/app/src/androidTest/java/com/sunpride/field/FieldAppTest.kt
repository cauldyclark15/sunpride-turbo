package com.sunpride.field

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
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
        override val isSignedIn get() = signedIn
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) { signInError?.let { throw it }; signedIn = true }
        override fun signOut() { signedIn = false }
        override fun refreshEnrollment(signer: DeviceSigner) = enrollment
    }

    @After fun cleanUp() = KeystoreDeviceKey.delete(alias)

    @Test fun signInIsEnabledOnceCredentialsAreEnteredAndPillShowsOffline() {
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertTextContains("Offline — not signed in", substring = true)
        rule.onNodeWithTag("sign-in-note").assertExists()
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
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("public-key") }
        val signer = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        rule.onNodeWithTag("enrollment-title").assertTextContains("This phone isn't registered yet")
        rule.onNodeWithTag("sync-status").assertTextContains("Signed in — phone not registered", substring = true)
        rule.onNodeWithTag("public-key").assertTextContains(signer.publicKeyBase64)
        rule.onNodeWithTag("key-fingerprint").assertTextContains(fingerprint(signer.publicKeySpki), substring = true)
        rule.onNodeWithTag("device-info").assertTextContains(android.os.Build.MODEL, substring = true)
        rule.onNodeWithTag("copy-key").performScrollTo().assertIsEnabled()
        rule.onNodeWithTag("check-again").performScrollTo().assertIsEnabled()
    }

    @Test fun readyAndRemovedStates() {
        val backend = ScriptedBackend(EnrollmentState.Ready("dev1")).apply { signedIn = true }
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("today-title") }
        rule.onNodeWithTag("today-title").assertTextContains("Today")
        rule.onNodeWithTag("sync-status").assertTextContains("Ready", substring = true)
        backend.enrollment = EnrollmentState.Removed
        rule.onNodeWithTag("sign-out").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTagExists("shell-title") }
    }

    @Test fun revokedPhoneShowsRemoved() {
        val backend = ScriptedBackend(EnrollmentState.Removed).apply { signedIn = true }
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend) }
        rule.waitUntil(10_000) {
            runCatching { rule.onNodeWithTag("enrollment-title").assertTextContains("This phone was removed — ask your admin") }.isSuccess
        }
        rule.onNodeWithTag("sync-status").assertTextContains("Phone removed", substring = true)
    }

    @Test fun todayRendersSavedVisitsAndStaleState() {
        rule.setContent {
            TodayScreen(TodayData(listOf(VisitDisplay("Outlet One", "Planned", "Pending")),
                1790380800000L, stale = true, warning = "Offline verification pending"), false, {}, {})
        }
        rule.onNodeWithTag("today-title").assertTextContains("Today")
        rule.onNodeWithTag("today-stale").assertTextContains("Stale", substring = true)
        rule.onNodeWithTag("today-visit").assertTextContains("Outlet One", substring = true)
        rule.onNodeWithTag("last-synced").assertTextContains("Last synced", substring = true)
        rule.onNodeWithTag("sync-now").assertIsEnabled()
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

    @Test fun designTokensPreview() {
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("design-tokens-link").performClick()
        rule.onNodeWithTag("design-tokens-screen").assertIsDisplayed()
    }

    @Test fun darkAtDoubleFontScaleKeepsKeyNodes() {
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                FieldApp(configured, dark = true, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered))
            }
        }
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertIsDisplayed()
        rule.onNodeWithTag("sign-in").assertExists().assertIsNotEnabled()
    }

    @Test fun missingEndpointsShowVisibleError() {
        rule.setContent { FieldApp(AppEnvironment("", ""), dark = false, debug = true, backend = ScriptedBackend(EnrollmentState.Unregistered)) }
        rule.onNodeWithTag("environment-error").assertIsDisplayed()
        rule.onNodeWithTag("sync-status").assertIsDisplayed()
    }

    private fun <R : org.junit.rules.TestRule, A : androidx.activity.ComponentActivity>
        androidx.compose.ui.test.junit4.AndroidComposeTestRule<R, A>.onAllNodesWithTagExists(tag: String) =
        onAllNodes(androidx.compose.ui.test.hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
}
