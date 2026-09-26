package com.sunpride.field.ui

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

class FieldControllerTest {
    private class FakeBackend : FieldBackend {
        var signedIn = false
        var signInError: AuthFailure? = null
        val results = ArrayDeque<() -> EnrollmentState>()
        var signOuts = 0
        var cached: String? = null
        val todaySyncs = mutableListOf<Boolean>()
        override val cachedDeviceId get() = cached
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            todaySyncs += sync
            return if (sync) TodayData(lastSynced = 150, stale = false) else TodayData()
        }
        override val isSignedIn get() = signedIn
        override fun loadSigner(): DeviceSigner = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.STRONGBOX)
        override fun signIn(email: String, password: String) { signInError?.let { throw it }; signedIn = true }
        override fun signOut() { signOuts++; signedIn = false }
        override fun refreshEnrollment(signer: DeviceSigner) = results.removeFirst()()
    }

    private fun run(block: suspend (FieldController, FakeBackend, MutableList<DeviceKeyInfo>) -> Unit) = runBlocking {
        val backend = FakeBackend()
        val exported = mutableListOf<DeviceKeyInfo>()
        val controller = FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext) { exported += it }
        block(controller, backend, exported)
    }

    @Test fun signInThenUnregisteredShowsKeyAndExportsPublicKeyOnce() = run { c, b, exported ->
        b.results += { EnrollmentState.Unregistered }
        c.signIn("a@example.test", "fake").join()
        assertEquals(EnrollmentState.Unregistered, c.state)
        assertEquals(CryptoVectors.json.getString("publicKeySpkiBase64"), c.key!!.publicKey)
        assertEquals("StrongBox", c.key!!.protection)
        assertEquals(1, exported.size)
        b.results += { EnrollmentState.Ready("dev1") }
        c.refresh()
        assertEquals(EnrollmentState.Ready("dev1"), c.state)
        assertEquals(1, exported.size)
        assertNull(c.error)
    }

    @Test fun readyTransitionBootstrapsWithoutSyncTap() = run { c, b, _ ->
        b.results += { EnrollmentState.Unregistered }
        c.signIn("a@example.test", "fake").join()
        b.results += { EnrollmentState.Ready("dev1") }
        c.checkAgain(quiet = true).join() // admin registration discovered by polling
        assertEquals(listOf(true), b.todaySyncs)
        assertEquals(150L, c.today.lastSynced)
        assertEquals(EnrollmentState.Ready("dev1"), c.state)
    }

    @Test fun readyOnLaunchWithoutSnapshotBootstrapsAfterVerification() = run { c, b, _ ->
        b.signedIn = true
        b.cached = "dev1"
        b.results += { EnrollmentState.Ready("dev1") }
        c.start().join()
        assertEquals(listOf(false, true), b.todaySyncs)
        assertEquals(150L, c.today.lastSynced)
        assertFalse(c.today.stale)
    }

    @Test fun wrongPasswordStaysSignedOutWithMessage() = run { c, b, _ ->
        b.signInError = AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)
        c.signIn("a@example.test", "wrong").join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals(AuthFailure.Kind.INVALID_CREDENTIALS.message, c.error)
        assertFalse(c.busy)
    }

    @Test fun launchSignedOutCreatesKeyButMakesNoServerCall() = run { c, b, exported ->
        c.start().join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals(1, exported.size)
        assertEquals(0, b.results.size)
    }

    @Test fun launchWithStoredSessionReverifies() = run { c, b, _ ->
        b.signedIn = true
        b.results += { EnrollmentState.Removed }
        c.start().join()
        assertEquals(EnrollmentState.Removed, c.state)
    }

    @Test fun offlineDuringCheckKeepsStateAndShowsError() = run { c, b, _ ->
        b.results += { EnrollmentState.Unregistered }
        c.signIn("a@example.test", "p").join()
        b.results += { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        c.refresh()
        assertEquals(EnrollmentState.Unregistered, c.state)
        assertEquals(AuthFailure.Kind.OFFLINE.message, c.error)
    }

    @Test fun expiredSessionReturnsToSignIn() = run { c, b, _ ->
        b.results += { EnrollmentState.Unregistered }
        c.signIn("a@example.test", "p").join()
        b.results += { throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED) }
        c.refresh()
        assertEquals(EnrollmentState.SignedOut, c.state)
    }

    @Test fun signOutWipesAndReturnsToSignIn() = run { c, b, _ ->
        b.results += { EnrollmentState.Ready("d") }
        c.signIn("a@example.test", "p").join()
        c.signOut().join()
        assertEquals(1, b.signOuts)
        assertEquals(EnrollmentState.SignedOut, c.state)
    }

    @Test fun pillMapping() {
        assertEquals(StatusPill.OFFLINE, StatusPill.of(EnrollmentState.SignedOut))
        assertEquals(StatusPill.UNREGISTERED, StatusPill.of(EnrollmentState.Unregistered))
        assertEquals(StatusPill.READY, StatusPill.of(EnrollmentState.Ready("d")))
        assertEquals(StatusPill.REMOVED, StatusPill.of(EnrollmentState.Removed))
        assertEquals("Offline — not signed in", StatusPill.OFFLINE.label)
        assertEquals("Signed in — phone not registered", StatusPill.UNREGISTERED.label)
        assertEquals(SunprideTokens.yellow, StatusPill.OFFLINE.background)
        assertEquals(SunprideTokens.yellow, StatusPill.UNREGISTERED.background)
    }
}
