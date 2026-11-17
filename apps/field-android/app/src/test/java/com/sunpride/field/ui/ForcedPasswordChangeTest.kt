package com.sunpride.field.ui

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

/** SP-0186: the forced Set a new password screen comes before Today and sync, survives restart, wipes nothing. */
class ForcedPasswordChangeTest {
    private class Backend : FieldBackend {
        var signedIn = false
        var required = false
        var requiredOnSignIn = false
        var cached: String? = null
        var signOuts = 0
        var refreshes = 0
        val todaySyncs = mutableListOf<Boolean>()
        var todayFailure: Exception? = null
        val changes = mutableListOf<Triple<String, String, String>>()
        var listener: (() -> Unit)? = null
        var refreshAction: () -> EnrollmentState = { EnrollmentState.Ready("dev1") }
        override val isSignedIn get() = signedIn
        override val cachedDeviceId get() = cached
        override fun loadSigner(): DeviceSigner = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.STRONGBOX)
        override fun signIn(email: String, password: String) { signedIn = true; required = requiredOnSignIn }
        override fun signOut() { signOuts++; signedIn = false }
        override fun passwordChangeRequired() = signedIn && required
        override fun setPasswordChangeListener(listener: (() -> Unit)?) { this.listener = listener }
        override fun changePassword(current: String, next: String, confirm: String) { changes += Triple(current, next, confirm); required = false }
        override fun refreshEnrollment(signer: DeviceSigner): EnrollmentState { refreshes++; return refreshAction() }
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            todaySyncs += sync; todayFailure?.let { throw it }
            return TodayData(lastSynced = 1, stale = false)
        }
    }

    private fun run(block: suspend (FieldController, Backend) -> Unit) = runBlocking {
        val b = Backend()
        block(FieldController(b, this, Dispatchers.Unconfined, EmptyCoroutineContext), b)
    }

    @Test fun signInWithTemporaryPasswordShowsTheScreenBeforeTodayOrSync() = run { c, b ->
        b.requiredOnSignIn = true
        c.signIn("a@example.test", "K7PQ-M4XR-2W").join()
        assertTrue(c.mustChangePassword)
        assertEquals("K7PQ-M4XR-2W", c.temporaryPassword) // memory only, for the prefilled field
        assertEquals(0, b.refreshes)
        assertTrue(b.todaySyncs.isEmpty())
        c.syncNow().join()
        assertTrue(b.todaySyncs.isEmpty())
        c.changePassword("K7PQ-M4XR-2W", "my-own-password", "my-own-password").join()
        assertTrue(c.passwordChanged)
        assertNull(c.temporaryPassword)
        c.finishForcedPasswordChange().join()
        assertFalse(c.mustChangePassword)
        assertEquals(EnrollmentState.Ready("dev1"), c.state)
        assertEquals(listOf(true), b.todaySyncs)
        assertEquals(0, b.signOuts)
    }

    @Test fun restartMidFlowComesBackToTheScreenWithoutTodayOrSync() = run { c, b ->
        b.signedIn = true; b.required = true; b.cached = "dev1"
        b.refreshAction = { throw AuthFailure(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED) }
        c.start().join()
        assertTrue(c.mustChangePassword)
        assertNull(c.temporaryPassword)
        assertTrue(b.todaySyncs.isEmpty())
        assertEquals(1, b.refreshes)
        assertEquals(0, b.signOuts)
        assertNotEquals(EnrollmentState.SignedOut, c.state)
    }

    @Test fun restartAfterSettingItOnTheWebsiteContinuesNormally() = run { c, b ->
        b.signedIn = true; b.required = true; b.cached = "dev1"
        b.refreshAction = { b.required = false; EnrollmentState.Ready("dev1") } // /api/me said it was done
        c.start().join()
        assertFalse(c.mustChangePassword)
        assertEquals(listOf(true), b.todaySyncs)
    }

    @Test fun refusalFromAnySyncRoutesToTheScreenAndKeepsWork() = run { c, b ->
        c.signIn("a@example.test", "fake-password").join()
        assertFalse(c.mustChangePassword)
        b.todayFailure = AuthFailure(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED); b.required = true
        c.syncNow().join()
        assertTrue(c.mustChangePassword)
        assertEquals(0, b.signOuts)
        assertNotEquals(EnrollmentState.SignedOut, c.state)
    }

    @Test fun backgroundRefusalReportedByTheBackendRoutesToTheScreen() = run { c, b ->
        c.signIn("a@example.test", "fake-password").join()
        b.required = true
        b.listener!!.invoke()
        kotlinx.coroutines.yield() // the listener hops to the UI context
        assertTrue(c.mustChangePassword)
        assertEquals(0, b.signOuts)
    }

    @Test fun expiredTemporaryPasswordStaysOnSignInWithPlainWords() = run { c, _ ->
        assertEquals("This temporary password has expired. Ask your admin for a new one.",
            FieldController.userMessage(AuthFailure(AuthFailure.Kind.TEMPORARY_PASSWORD_EXPIRED)))
        assertEquals(EnrollmentState.SignedOut, c.state)
    }

    @Test fun signOutClearsTheInMemoryTemporaryPassword() = run { c, b ->
        b.requiredOnSignIn = true
        c.signIn("a@example.test", "K7PQ-M4XR-2W").join()
        c.signOut().join()
        assertFalse(c.mustChangePassword)
        assertNull(c.temporaryPassword)
    }
}
