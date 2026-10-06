package com.sunpride.field.auth

import com.sunpride.field.ui.BiometricGate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0128 fingerprint/face sign-in: the vault and the launch-gate state machine, with a scripted prompt. */
class BiometricSignInTest {
    /** Scripted system prompt: "seals" by reversing bytes behind a 12-byte fake IV; never a real key. */
    private class FakeCrypto(var availability: BiometricAvailability = BiometricAvailability.AVAILABLE) : BiometricCrypto {
        var next: CryptoOutcome? = null // null = authenticate successfully
        var prompts = 0
        var deletes = 0
        var hold = false
        var held: (() -> Unit)? = null
        override fun availability() = availability
        override fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit) {
            prompts++
            val result = next ?: CryptoOutcome.Done(ByteArray(12) + plain.reversedArray())
            if (hold) held = { done(result) } else done(result)
        }
        override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) {
            prompts++
            val result = next ?: CryptoOutcome.Done(sealed.copyOfRange(12, sealed.size).reversedArray())
            if (hold) held = { done(result) } else done(result)
        }
        override fun deleteKey() { deletes++ }
    }

    private val plain = InMemorySessionVault()
    private val sealed = InMemorySealedTokenStore()
    private var memory = SessionMemory()
    private var keyDeletes = 0
    private fun vault() = LockableSessionVault(plain, sealed, memory) { keyDeletes++ }
    private val crypto = FakeCrypto()

    /** A fresh process: new memory, same stored data. */
    private fun relaunch(): BiometricGate { memory = SessionMemory(); return BiometricGate(vault(), crypto) }

    private fun signedInWithBiometrics(): BiometricGate {
        val vault = vault()
        vault.saveSession("fake-session-1"); vault.deviceId = "dev1"
        val gate = BiometricGate(vault, crypto)
        gate.passwordSignedIn()
        assertTrue(gate.offer)
        gate.enable()
        assertTrue(gate.enabled)
        return gate
    }

    @Test fun withoutBiometricsTheAppOpensAsBefore() {
        vault().saveSession("fake-session-1")
        val gate = relaunch()
        assertEquals(BiometricGate.Step.OPEN, gate.step)
        assertFalse(gate.enabled)
        assertEquals("fake-session-1", vault().readSession())
        assertEquals(0, crypto.prompts)
    }

    @Test fun enablingMovesTheSessionUnderTheBiometricKeyAndNeverStoresThePassword() {
        val gate = signedInWithBiometrics()
        assertFalse(gate.offer)
        assertNull("ordinary copy removed", plain.readSession())
        assertEquals("dev1", plain.deviceId)
        val blob = sealed.read()!!
        assertFalse(String(blob, Charsets.UTF_8).contains("fake-session-1"))
        // Same process keeps working without another prompt.
        assertEquals("fake-session-1", vault().readSession())
        assertEquals(1, crypto.prompts)
    }

    @Test fun launchWithStoredSessionPromptsAndUnlocksIntoMemoryOnly() {
        signedInWithBiometrics()
        val gate = relaunch()
        assertEquals(BiometricGate.Step.LOCKED, gate.step)
        assertNull("locked process has no session", vault().readSession())
        assertTrue(vault().isLocked)
        gate.unlock()
        assertEquals(BiometricGate.Step.OPEN, gate.step)
        assertEquals(1, gate.unlocks)
        assertEquals("fake-session-1", vault().readSession())
        assertNull(plain.readSession())
        assertTrue(gate.enabled)
    }

    @Test fun cancelGoesToThePasswordScreenAndCanRetry() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.next = CryptoOutcome.Cancelled
        gate.unlock()
        assertEquals(BiometricGate.Step.PASSWORD, gate.step)
        assertNull(gate.message)
        assertTrue(gate.canRetry)
        assertNull(vault().readSession())
        assertTrue("sealed session kept for a retry", vault().biometricOn)
        crypto.next = null
        gate.unlock()
        assertEquals(BiometricGate.Step.OPEN, gate.step)
        assertEquals("fake-session-1", vault().readSession())
    }

    @Test fun usePasswordFromTheLockScreenSkipsThePrompt() {
        signedInWithBiometrics()
        val gate = relaunch()
        val before = crypto.prompts
        gate.usePassword()
        assertEquals(BiometricGate.Step.PASSWORD, gate.step)
        assertEquals(before, crypto.prompts)
    }

    @Test fun newlyEnrolledBiometricsInvalidateTheKeyAndFallBackToPasswordWithAClearMessage() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.next = CryptoOutcome.Invalidated
        val deletes = crypto.deletes
        gate.unlock()
        assertEquals(BiometricGate.Step.PASSWORD, gate.step)
        assertEquals(BiometricGate.INVALIDATED, gate.message)
        assertFalse(gate.enabled)
        assertFalse(gate.canRetry)
        assertFalse(vault().biometricOn)
        assertNull(vault().readSession())
        assertEquals(deletes + 1, crypto.deletes)
        // Next launch goes straight to the normal sign-in.
        assertEquals(BiometricGate.Step.OPEN, relaunch().step)
    }

    @Test fun lockoutAndFailureKeepTheSealedSessionAndExplainThePasswordFallback() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.next = CryptoOutcome.LockedOut
        gate.unlock()
        assertEquals(BiometricGate.LOCKED_OUT, gate.message)
        assertTrue(vault().biometricOn)
        crypto.next = CryptoOutcome.Failed
        gate.unlock()
        assertEquals(BiometricGate.FAILED, gate.message)
        assertTrue(gate.canRetry)
    }

    @Test fun corruptUnlockedBytesAreTreatedAsInvalidated() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.next = CryptoOutcome.Done(ByteArray(0))
        gate.unlock()
        assertEquals(BiometricGate.INVALIDATED, gate.message)
        assertFalse(vault().biometricOn)
    }

    @Test fun passwordSignInAfterCancelReplacesTheSessionAndTurnsBiometricsOff() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.next = CryptoOutcome.Cancelled
        gate.unlock()
        val deletes = keyDeletes
        vault().saveSession("fake-session-2") // AuthClient.signIn after the password screen
        gate.passwordSignedIn()
        assertEquals(BiometricGate.Step.OPEN, gate.step)
        assertFalse(gate.enabled)
        assertTrue("offered again", gate.offer)
        assertFalse(vault().biometricOn)
        assertEquals(deletes + 1, keyDeletes)
        assertEquals("fake-session-2", vault().readSession())
    }

    @Test fun noOfferWithoutAnEnrolledStrongBiometric() {
        crypto.availability = BiometricAvailability.NOT_ENROLLED
        vault().saveSession("fake-session-1")
        val gate = relaunch()
        gate.passwordSignedIn()
        assertFalse(gate.offer)
        crypto.availability = BiometricAvailability.UNAVAILABLE
        gate.passwordSignedIn()
        assertFalse(gate.offer)
    }

    @Test fun declineOrCancelledEnableKeepsTheOrdinarySession() {
        vault().saveSession("fake-session-1")
        val gate = relaunch()
        gate.passwordSignedIn()
        gate.decline()
        assertFalse(gate.offer)
        crypto.next = CryptoOutcome.Cancelled
        gate.enable()
        assertFalse(gate.enabled)
        assertNull(gate.message)
        assertEquals("fake-session-1", plain.readSession())
        crypto.next = CryptoOutcome.Failed
        gate.enable()
        assertEquals(BiometricGate.ENABLE_FAILED, gate.message)
        assertFalse(vault().biometricOn)
        assertEquals("fake-session-1", relaunch().let { vault().readSession() })
    }

    @Test fun accountToggleOffRestoresTheOrdinarySessionWithoutAPrompt() {
        val gate = signedInWithBiometrics()
        val prompts = crypto.prompts
        gate.disable()
        assertFalse(gate.enabled)
        assertEquals(prompts, crypto.prompts)
        assertFalse(vault().biometricOn)
        assertEquals("fake-session-1", plain.readSession())
        assertEquals(BiometricGate.Step.OPEN, relaunch().step)
        assertEquals("fake-session-1", vault().readSession())
    }

    @Test fun signOutClearsTheKeyTheSealedSessionAndTheUnlockedToken() {
        val gate = signedInWithBiometrics()
        val deletes = keyDeletes
        vault().wipe() // AuthClient.signOut / dead session
        gate.signedOut()
        assertFalse(gate.enabled)
        assertNull(vault().readSession())
        assertNull(sealed.read())
        assertNull(plain.deviceId)
        assertEquals(deletes + 1, keyDeletes)
        assertEquals(BiometricGate.Step.OPEN, relaunch().step)
    }

    @Test fun clearSessionKeepsTheDeviceId() {
        val vault = vault()
        vault.saveSession("fake-session-1"); vault.deviceId = "dev1"
        vault.clearSession()
        assertNull(vault.readSession())
        assertEquals("dev1", vault.deviceId)
    }

    @Test fun promptInFlightIgnoresRepeatedTaps() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.hold = true
        gate.unlock(); gate.unlock()
        assertTrue(gate.busy)
        assertEquals(BiometricGate.Step.LOCKED, gate.step)
        val prompts = crypto.prompts
        crypto.held!!.invoke()
        assertFalse(gate.busy)
        assertEquals(BiometricGate.Step.OPEN, gate.step)
        assertEquals(prompts, crypto.prompts)
    }

    @Test fun aPromptThatNeverReportsBackCannotTrapThePerson() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.hold = true
        gate.unlock()
        gate.usePassword()
        assertFalse(gate.busy)
        assertEquals(BiometricGate.Step.PASSWORD, gate.step)
        assertTrue(gate.canRetry)
        crypto.hold = false
        gate.unlock()
        assertEquals(BiometricGate.Step.OPEN, gate.step)
    }

    @Test fun backgroundWorkersInALockedProcessSeeNoSessionAndCannotWipeIt() {
        signedInWithBiometrics()
        memory = SessionMemory()
        val worker = vault()
        assertNull(worker.readSession())
        // AuthClient.isSignedIn is false: workers return early instead of treating it as signed out.
        assertTrue(AuthClient(com.sunpride.field.AppEnvironment("https://x.convex.site", "https://x.convex.cloud"), worker)
            .isSignedIn.not())
        assertTrue(worker.biometricOn)
    }
}
