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

    // ---- Release-check counterexamples: stale prompt callbacks and failed durable removal ----

    @Test fun aLateUnlockCannotReplaceANewPasswordSession() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.hold = true
        gate.unlock()
        gate.usePassword()
        vault().saveSession("fake-session-B")
        gate.passwordSignedIn()
        crypto.held!!.invoke() // account A's prompt finally succeeds
        assertEquals("fake-session-B", vault().readSession())
        assertEquals(0, gate.unlocks)
        assertFalse(gate.busy)
        assertEquals(BiometricGate.Step.OPEN, gate.step)
    }

    @Test fun aLateUnlockCannotUndoSignOut() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.hold = true
        gate.unlock()
        gate.usePassword()
        vault().wipe()
        gate.signedOut()
        crypto.held!!.invoke()
        assertNull(vault().readSession())
        assertNull(memory.token)
        assertFalse(vault().biometricOn)
        assertEquals(0, gate.unlocks)
        assertEquals(BiometricGate.Step.OPEN, relaunch().step)
    }

    @Test fun aLateUnlockFromAWorkerSignOutIsRefusedEvenWithoutTheGateBeingTold() {
        signedInWithBiometrics()
        val gate = relaunch()
        crypto.hold = true
        gate.unlock()
        vault().wipe() // e.g. AuthClient got 401 on a background thread
        crypto.held!!.invoke()
        assertNull(vault().readSession())
        assertEquals(0, gate.unlocks)
    }

    @Test fun aLateEnableCannotSealThePreviousAccountAfterAnotherSignIn() {
        val vault = vault()
        vault.saveSession("fake-session-A")
        val gate = BiometricGate(vault, crypto)
        gate.passwordSignedIn()
        crypto.hold = true
        gate.enable()
        vault.saveSession("fake-session-B")
        gate.passwordSignedIn()
        val deletes = crypto.deletes
        crypto.held!!.invoke() // A's enable prompt completes late
        assertFalse(vault.biometricOn)
        assertFalse(gate.enabled)
        assertEquals("stale enable never deletes the newer session's key", deletes, crypto.deletes)
        crypto.hold = false
        val cold = relaunch()
        assertEquals(BiometricGate.Step.OPEN, cold.step)
        assertEquals("fake-session-B", vault().readSession())
    }

    @Test fun aLateEnableCannotSealAfterSignOut() {
        val vault = vault()
        vault.saveSession("fake-session-A")
        val gate = BiometricGate(vault, crypto)
        crypto.hold = true
        gate.enable()
        vault.wipe()
        gate.signedOut()
        crypto.held!!.invoke()
        assertNull(sealed.read())
        assertNull(vault().readSession())
    }

    /** SharedPreferences.commit() returning false silently kept the ordinary copy on disk. */
    private class StickyPlain : SessionVault {
        var token: String? = null
        override var deviceId: String? = "dev1"
        override fun readSession() = token
        override fun saveSession(token: String) { this.token = token }
        override fun wipe() { token = null }
        override fun clearSession() = Unit // removal fails without throwing
    }

    @Test fun aRetainedOrdinaryCopyNeverBypassesEnabledBiometricsOnColdStart() {
        val disk = StickyPlain()
        val vault = LockableSessionVault(disk, sealed, memory)
        vault.saveSession("fake-session-A")
        BiometricGate(vault, crypto).enable()
        assertEquals("fake-session-A", disk.token) // the removal really failed
        memory = SessionMemory()
        val cold = LockableSessionVault(disk, sealed, memory)
        assertTrue(cold.isLocked)
        assertNull("the ordinary copy is ignored while a sealed session exists", cold.readSession())
        assertEquals(BiometricGate.Step.LOCKED, BiometricGate(cold, crypto).step)
    }

    @Test fun aSealedSessionThatCannotBeRemovedFailsThePasswordSignInInsteadOfHidingIt() {
        val stuck = object : SealedTokenStore {
            var blob: ByteArray? = byteArrayOf(1, 2, 3)
            override fun read() = blob
            override fun write(blob: ByteArray) { this.blob = blob }
            override fun clear() = Unit // removal fails without throwing
        }
        val vault = LockableSessionVault(plain, stuck, memory)
        assertTrue(runCatching { vault.saveSession("fake-session-B") }.exceptionOrNull() is SessionStorageFailure)
        assertNull(vault.readSession())
    }

    @Test fun aFailedSealWriteKeepsTheOrdinarySession() {
        val broken = object : SealedTokenStore {
            override fun read(): ByteArray? = null
            override fun write(blob: ByteArray) = Unit // not persisted
            override fun clear() = Unit
        }
        val vault = LockableSessionVault(plain, broken, memory) { keyDeletes++ }
        vault.saveSession("fake-session-1")
        val gate = BiometricGate(vault, crypto)
        gate.enable()
        assertFalse(gate.enabled)
        assertEquals(BiometricGate.ENABLE_FAILED, gate.message)
        assertEquals("fake-session-1", plain.readSession())
    }

    /** Ordinary storage that refuses every write (commit() false -> throws) while old data stays readable. */
    private class RefusingPlain : SessionVault {
        var token: String? = null
        var refuse = false
        override var deviceId: String? = "dev1"
        override fun readSession() = token
        override fun saveSession(token: String) { if (refuse) throw SessionStorageFailure(); this.token = token }
        override fun wipe() { if (refuse) throw SessionStorageFailure(); token = null; deviceId = null }
        override fun clearSession() { if (refuse) throw SessionStorageFailure(); token = null }
    }

    private fun enabledWithStuckOrdinaryCopy(disk: RefusingPlain): LockableSessionVault {
        val vault = LockableSessionVault(disk, sealed, memory) { keyDeletes++ }
        vault.saveSession("fake-session-A")
        disk.refuse = true
        BiometricGate(vault, crypto).enable()
        assertEquals("fake-session-A", disk.token) // removal really failed
        memory = SessionMemory()
        return LockableSessionVault(disk, sealed, memory) { keyDeletes++ }
    }

    @Test fun invalidationNeverReopensAnOrdinaryCopyWhoseRemovalFailed() {
        val disk = RefusingPlain()
        val cold = enabledWithStuckOrdinaryCopy(disk)
        val gate = BiometricGate(cold, crypto)
        assertEquals(BiometricGate.Step.LOCKED, gate.step)
        crypto.next = CryptoOutcome.Invalidated
        gate.unlock()
        assertEquals(BiometricGate.Step.PASSWORD, gate.step)
        assertEquals(BiometricGate.INVALIDATED, gate.message)
        assertNull(cold.readSession())
        memory = SessionMemory()
        val reopened = LockableSessionVault(disk, sealed, memory)
        assertNull("the kept ordinary copy stays hidden after a cold start", reopened.readSession())
        assertFalse(reopened.biometricOn)
        assertFalse(reopened.isLocked) // marker only: the sign-in screen, no prompt for a dead key
        assertEquals("fake-session-A", disk.token)
    }

    @Test fun signOutNeverReopensAnOrdinaryCopyWhoseRemovalFailed() {
        val disk = RefusingPlain()
        val cold = enabledWithStuckOrdinaryCopy(disk)
        val auth = AuthClient(com.sunpride.field.AppEnvironment("", ""), cold)
        assertTrue(runCatching { auth.signOut() }.exceptionOrNull() is SessionStorageFailure)
        assertNull(cold.readSession())
        memory = SessionMemory()
        val reopened = LockableSessionVault(disk, sealed, memory)
        assertNull("sign-out must not reopen the kept ordinary copy", reopened.readSession())
        assertEquals(BiometricGate.Step.OPEN, BiometricGate(reopened, crypto).step)
        assertFalse(AuthClient(com.sunpride.field.AppEnvironment("", ""), reopened).isSignedIn)
    }

    @Test fun signOutWithoutBiometricsStillFailsClosedWhenTheOrdinaryCopyStays() {
        val disk = RefusingPlain()
        val vault = LockableSessionVault(disk, sealed, memory)
        vault.saveSession("fake-session-A")
        disk.refuse = true
        assertTrue(runCatching { vault.wipe() }.exceptionOrNull() is SessionStorageFailure)
        memory = SessionMemory()
        assertNull(LockableSessionVault(disk, sealed, memory).readSession())
    }

    @Test fun aPasswordSignInClearsTheSignedOutMarkerOnceStorageWorks() {
        val disk = RefusingPlain()
        val cold = enabledWithStuckOrdinaryCopy(disk)
        runCatching { cold.wipe() }
        assertTrue(runCatching { cold.saveSession("fake-session-B") }.exceptionOrNull() is SessionStorageFailure)
        assertNull("a failed password save leaves the marker hiding the old copy", cold.readSession())
        disk.refuse = false
        cold.saveSession("fake-session-B")
        assertEquals("fake-session-B", cold.readSession())
        assertNull(sealed.read())
        memory = SessionMemory()
        assertEquals("fake-session-B", LockableSessionVault(disk, sealed, memory).readSession())
    }

    @Test fun aSealedClearFailureRollsBackTheNewOrdinaryCopy() {
        val stuck = object : SealedTokenStore {
            var blob: ByteArray? = byteArrayOf(1, 2, 3)
            override fun read() = blob
            override fun write(blob: ByteArray) { this.blob = blob }
            override fun clear() = throw SessionStorageFailure()
        }
        val vault = LockableSessionVault(plain, stuck, memory)
        assertTrue(runCatching { vault.saveSession("fake-session-B") }.exceptionOrNull() is SessionStorageFailure)
        assertNull(plain.readSession())
        assertTrue(vault.isLocked)
    }

    @Test fun turningOffWhileLockedSignsOutAndNeverReopensAKeptOrdinaryCopy() {
        val disk = RefusingPlain()
        val locked = enabledWithStuckOrdinaryCopy(disk)
        assertTrue(runCatching { locked.unseal() }.exceptionOrNull() is SessionStorageFailure)
        assertFalse(locked.biometricOn)
        assertNull(locked.readSession())
        memory = SessionMemory()
        assertNull(LockableSessionVault(disk, sealed, memory).readSession())
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
