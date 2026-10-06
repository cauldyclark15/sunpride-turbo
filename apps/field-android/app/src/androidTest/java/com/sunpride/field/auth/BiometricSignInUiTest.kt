package com.sunpride.field.auth

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.Lifecycle
import com.sunpride.field.AppEnvironment
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.BiometricGate
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.TodayData
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/**
 * SP-0128 on the phone: show/hide password and the fingerprint/face sign-in flow through the real FieldApp,
 * with the BiometricPrompt test seam (scripted outcomes). The real system prompt is proven separately by
 * [BiometricKeystoreTest]'s screenshot.
 */
class BiometricSignInUiTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val configured = AppEnvironment("https://team.convex.site", "https://team.convex.cloud")
    private val alias = "sunpride-field-device-bio-ui-test"
    private val plain = InMemorySessionVault()
    private val sealed = InMemorySealedTokenStore()
    private var memory = SessionMemory()
    private fun vault() = LockableSessionVault(plain, sealed, memory)

    private class ScriptedCrypto : BiometricCrypto {
        @Volatile var next: CryptoOutcome? = null
        @Volatile var prompts = 0
        override fun availability() = BiometricAvailability.AVAILABLE
        override fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit) {
            prompts++; done(next ?: CryptoOutcome.Done(ByteArray(12) + plain.reversedArray()))
        }
        override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) {
            prompts++; done(next ?: CryptoOutcome.Done(sealed.copyOfRange(12, sealed.size).reversedArray()))
        }
        override fun deleteKey() = Unit
    }
    private val crypto = ScriptedCrypto()

    /** Server stand-in: sign-in stores a fake session in the real lockable vault; no network. */
    private inner class Backend(private val vault: LockableSessionVault) : FieldBackend {
        var syncs = 0
        override val isSignedIn get() = vault.readSession() != null
        override val cachedDeviceId get() = vault.deviceId
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(rule.activity, alias)
        override fun signIn(email: String, password: String) {
            assertFalse("password never reaches the vault", password.isEmpty()); vault.saveSession("fake-session-ui")
        }
        override fun signOut() { vault.wipe() }
        override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState {
            vault.deviceId = "dev1"; return EnrollmentState.Ready("dev1")
        }
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            if (sync) syncs++; return TodayData()
        }
    }

    @After fun cleanUp() = KeystoreDeviceKey.delete(alias)

    private fun exists(tag: String) = rule.onAllNodes(hasTestTag(tag)).fetchSemanticsNodes().isNotEmpty()
    private fun waitFor(tag: String) = rule.waitUntil(10_000) { exists(tag) }
    private fun fieldText(tag: String): String = rule.onNodeWithTag(tag).fetchSemanticsNode().config
        .getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
    private fun described(label: String) = SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(label))

    private fun launch(gate: BiometricGate, backend: Backend) {
        rule.setContent { FieldApp(configured, dark = false, debug = true, backend = backend, biometrics = gate) }
    }

    @Test fun passwordIsHiddenByDefaultTogglesAndReHidesWhenTheAppIsLeft() {
        val vault = vault()
        launch(BiometricGate(vault, crypto), Backend(vault))
        waitFor("password")
        rule.onNodeWithTag("password").performTextInput("fake-pass")
        assertFalse(fieldText("password").contains("fake-pass"))
        rule.onNodeWithTag("password-toggle").assert(described("Show password")).performClick()
        assertEquals("fake-pass", fieldText("password"))
        rule.onNodeWithTag("password-toggle").assert(described("Hide password")).performClick()
        assertFalse(fieldText("password").contains("fake-pass"))
        rule.onNodeWithTag("password-toggle").performClick()
        assertEquals("fake-pass", fieldText("password"))
        // Home / recents / screen off: hidden again on return.
        rule.activityRule.scenario.moveToState(Lifecycle.State.CREATED)
        rule.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        rule.waitForIdle()
        rule.onNodeWithTag("password-toggle").assert(described("Show password"))
        assertFalse(fieldText("password").contains("fake-pass"))
    }

    @Test fun offerAfterPasswordSignInSealsTheSessionAndAccountToggleTurnsItOff() {
        val vault = vault()
        val gate = BiometricGate(vault, crypto)
        launch(gate, Backend(vault))
        waitFor("email")
        rule.onNodeWithTag("email").performTextInput("seller@example.test")
        rule.onNodeWithTag("password").performTextInput("fake-password")
        rule.onNodeWithTag("password-toggle").performClick()
        rule.onNodeWithTag("sign-in").performClick()
        waitFor("biometric-offer")
        rule.onNodeWithTag("biometric-offer-accept").performClick()
        rule.waitUntil(10_000) { !exists("biometric-offer") }
        assertTrue(vault.biometricOn)
        assertNull("ordinary copy removed", plain.readSession())
        waitFor("today-title")
        rule.onNodeWithTag("account-open").performClick()
        rule.onNodeWithTag("biometric-toggle").assertIsOn()
        rule.onNodeWithTag("biometric-status").assertTextContains("On", substring = true)
        rule.onNodeWithTag("biometric-toggle").performClick()
        rule.onNodeWithTag("biometric-toggle").assertIsOff()
        assertFalse(vault.biometricOn)
        assertEquals("fake-session-ui", plain.readSession())
        // Leaving sign-in and coming back after sign-out: password empty and hidden again.
        rule.onNodeWithTag("sign-out").performClick()
        waitFor("password")
        assertEquals("", fieldText("password"))
        rule.onNodeWithTag("password-toggle").assert(described("Show password"))
    }

    @Test fun notNowKeepsTheOrdinarySession() {
        val vault = vault()
        launch(BiometricGate(vault, crypto), Backend(vault))
        waitFor("email")
        rule.onNodeWithTag("email").performTextInput("seller@example.test")
        rule.onNodeWithTag("password").performTextInput("fake-password")
        rule.onNodeWithTag("sign-in").performClick()
        waitFor("biometric-offer-decline")
        rule.onNodeWithTag("biometric-offer-decline").performClick()
        rule.waitUntil(10_000) { !exists("biometric-offer") }
        assertFalse(vault.biometricOn)
        assertEquals(0, crypto.prompts)
    }

    private fun sealedLaunch(): Pair<BiometricGate, Backend> {
        vault().apply { saveSession("fake-session-ui"); deviceId = "dev1" }
        BiometricGate(vault(), crypto).enable()
        memory = SessionMemory() // a new process: nothing unlocked
        val vault = vault()
        assertTrue(vault.isLocked)
        return BiometricGate(vault, crypto) to Backend(vault)
    }

    @Test fun launchWithAStoredSessionUnlocksStraightToTodayOffline() {
        val (gate, backend) = sealedLaunch()
        launch(gate, backend)
        waitFor("today-title")
        rule.onNodeWithTag("today-title").assertIsDisplayed()
    }

    @Test fun cancelShowsThePasswordScreenWithRetry() {
        val (gate, backend) = sealedLaunch()
        crypto.next = CryptoOutcome.Cancelled
        launch(gate, backend)
        waitFor("sign-in-biometric")
        rule.onNodeWithTag("shell-title").assertIsDisplayed()
        crypto.next = null
        rule.onNodeWithTag("sign-in-biometric").performClick()
        waitFor("today-title")
    }

    @Test fun lockScreenOffersThePasswordWhileThePromptIsUp() {
        val backend = sealedLaunch().second
        val never = object : BiometricCrypto by crypto {
            override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) = Unit // prompt still showing
        }
        val gate = BiometricGate(vault(), never)
        launch(gate, backend)
        waitFor("unlock-title")
        rule.onNodeWithTag("unlock-biometric").assertIsDisplayed()
        assertEquals(BiometricGate.Step.LOCKED, gate.step)
        assertFalse("nothing opened while locked", exists("today-title"))
        rule.onNodeWithTag("unlock-password").performClick()
        waitFor("shell-title")
        assertNull(vault().readSession())
    }

    @Test fun changedFingerprintsFallBackToPasswordWithAClearMessage() {
        val (gate, backend) = sealedLaunch()
        crypto.next = CryptoOutcome.Invalidated
        launch(gate, backend)
        waitFor("auth-error")
        rule.onNodeWithTag("auth-error").assertTextContains("Fingerprints or face on this phone changed", substring = true)
        assertFalse(exists("sign-in-biometric"))
        assertFalse(vault().biometricOn)
    }
}
