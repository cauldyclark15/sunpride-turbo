package com.sunpride.field.ui

import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.BiometricAvailability
import com.sunpride.field.auth.BiometricCrypto
import com.sunpride.field.auth.CryptoOutcome
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.auth.InMemorySealedTokenStore
import com.sunpride.field.auth.InMemorySessionVault
import com.sunpride.field.auth.LockableSessionVault
import com.sunpride.field.auth.SessionMemory
import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

/**
 * SP-0128 release check: sign-out must clear the session, sealed copy and biometric key even when the
 * fallible encrypted-cache purge (or the cache-index clear) fails. Exercises the production
 * [signOutTeardown] body that `LiveFieldBackend.signOut` delegates to, with the real AuthClient,
 * LockableSessionVault and BiometricGate, then the controller path that publishes SignedOut.
 */
class SignOutTeardownTest {
    private class Crypto : BiometricCrypto {
        var keyDeletes = 0
        override fun availability() = BiometricAvailability.AVAILABLE
        override fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit) = done(CryptoOutcome.Done(ByteArray(12) + plain.reversedArray()))
        override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) =
            done(CryptoOutcome.Done(sealed.copyOfRange(12, sealed.size).reversedArray()))
        override fun deleteKey() { keyDeletes++ }
    }

    private val plain = InMemorySessionVault()
    private val sealed = InMemorySealedTokenStore()
    private val crypto = Crypto()
    private var memory = SessionMemory()
    private fun vault() = LockableSessionVault(plain, sealed, memory) { crypto.deleteKey() }
    // Not configured: AuthClient skips the remote call, so only the local wipe runs (offline sign-out).
    private fun auth(v: LockableSessionVault) = AuthClient(AppEnvironment("", ""), v)

    /** Account A signed in with the password, then turned fingerprint sign-in on. */
    private fun signedInWithBiometrics(): LockableSessionVault {
        val v = vault()
        v.saveSession("session-account-A")
        BiometricGate(v, crypto).enable()
        assertTrue(v.biometricOn)
        return v
    }

    private fun failingPurge(): () -> Unit = { error("purge failed") }

    @Test fun purgeFailureStillWipesSessionSealedCopyAndKey() {
        val v = signedInWithBiometrics()
        val epoch = v.epoch
        val deletesBefore = crypto.keyDeletes
        val thrown = runCatching { signOutTeardown(failingPurge(), {}, { auth(v).signOut() }) }.exceptionOrNull()
        assertEquals("purge failed", thrown?.message)
        assertNull(v.readSession())
        assertFalse(v.biometricOn)
        assertNotEquals(epoch, v.epoch)
        assertTrue(crypto.keyDeletes > deletesBefore)
    }

    @Test fun purgeFailureDoesNotReopenOldAccountOnColdStart() {
        val v = signedInWithBiometrics()
        runCatching { signOutTeardown(failingPurge(), {}, { auth(v).signOut() }) }
        memory = SessionMemory()
        val cold = vault()
        val gate = BiometricGate(cold, crypto)
        gate.unlock()
        assertFalse(cold.isLocked)
        assertNull(cold.readSession())
        assertFalse(auth(cold).isSignedIn)
    }

    @Test fun indexClearFailureStillSignsOut() {
        val v = signedInWithBiometrics()
        val thrown = runCatching { signOutTeardown({}, { error("index failed") }, { auth(v).signOut() }) }.exceptionOrNull()
        assertEquals("index failed", thrown?.message)
        assertNull(v.readSession())
        assertFalse(v.biometricOn)
    }

    @Test fun everyStepRunsAndFirstFailureIsReported() {
        val ran = mutableListOf<String>()
        val thrown = runCatching {
            signOutTeardown({ ran += "purge"; error("first") }, { ran += "index"; error("second") }, { ran += "auth" })
        }.exceptionOrNull()
        assertEquals(listOf("purge", "index", "auth"), ran)
        assertEquals("first", thrown?.message)
    }

    @Test fun successfulTeardownSignsOutWithoutError() {
        val v = signedInWithBiometrics()
        signOutTeardown({}, {}, { auth(v).signOut() })
        assertNull(v.readSession())
        assertFalse(v.biometricOn)
    }

    /** The controller → backend path: purge fails, the screen shows sign-in AND nothing can reopen account A. */
    @Test fun controllerSignOutWithFailingPurgeLeavesNothingToReopen() = runBlocking {
        val v = signedInWithBiometrics()
        val backend = TeardownBackend(auth(v), failingPurge())
        val controller = FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext) {}
        controller.signOut().join()
        assertEquals(EnrollmentState.SignedOut, controller.state)
        assertFalse(backend.isSignedIn)
        assertFalse(v.biometricOn)
        memory = SessionMemory()
        val cold = vault()
        assertFalse(cold.isLocked)
        assertNull(cold.readSession())
    }

    /** Minimal backend whose sign-out is the production teardown with the real AuthClient. */
    private class TeardownBackend(private val auth: AuthClient, private val purge: () -> Unit) : FieldBackend {
        override val isSignedIn get() = auth.isSignedIn
        override val cachedDeviceId: String? get() = null
        override fun visitStates() = emptyList<Pair<com.sunpride.field.storage.IntentRow, String>>()
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: org.json.JSONObject?) = Unit
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData()
        override fun loadSigner(): DeviceSigner = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.STRONGBOX)
        override fun signIn(email: String, password: String) = throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        override fun signOut() = signOutTeardown(purge, {}, { auth.signOut() })
        override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState = EnrollmentState.SignedOut
        override fun team(directOnly: Boolean) = com.sunpride.field.ui.team.TeamView()
    }
}
