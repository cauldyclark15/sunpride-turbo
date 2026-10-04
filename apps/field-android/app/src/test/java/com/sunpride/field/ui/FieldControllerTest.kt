package com.sunpride.field.ui

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.CryptoVectors
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.JcaDeviceSigner
import com.sunpride.field.device.KeyProtection
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
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
        var todayResult: TodayData? = null
        val calls = mutableListOf<Pair<com.sunpride.field.storage.IntentRow, String>>()
        override fun visitStates() = calls.toList()
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: org.json.JSONObject?) {
            calls += com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory.create(
                com.sunpride.field.storage.StoreScope("a", "d", "s"), kind, clientVisitId, checkInRequestId,
                previousRequestId, plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode, location) to "pending"
        }
        override val cachedDeviceId get() = cached
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean): TodayData {
            todaySyncs += sync
            todayResult?.let { return it }
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

    @Test fun controllerEnforcesTypedCallOrderEvenWithoutUiAndAllowsNullLocation() = run { c, b, _ ->
        val first = VisitDisplay("First", "Planned", "Scheduled", "a", "p1", sequence = 0)
        val next = VisitDisplay("Next", "Planned", "Scheduled", "b", "p2", sequence = 1)
        b.todayResult = TodayData(visits = listOf(next, first))
        b.results += { EnrollmentState.Ready("d") }
        c.signIn("a@example.test", "fake").join()
        c.openDiagnostic(next).join()
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertEquals(com.sunpride.field.storage.VisitRuleFailure.Code.MCP_ORDER, c.diagnosticFailure)
        assertEquals(0, b.calls.size)
        c.openDiagnostic(first).join()
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertEquals(1, b.calls.size)
        c.openDiagnostic(next).join()
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertEquals(com.sunpride.field.storage.VisitRuleFailure.Code.CALL_OPEN, c.diagnosticFailure)
        c.openDiagnostic(first).join()
        c.queueDiagnostic("visit.checkOut", null, null, null, null).join()
        assertEquals(com.sunpride.field.storage.VisitRuleFailure.Code.OUTCOME_REQUIRED, c.diagnosticFailure)
        c.queueDiagnostic("visit.checkOut", null, null, "nonproductive", null).join()
        assertEquals(com.sunpride.field.storage.VisitRuleFailure.Code.REASON_REQUIRED, c.diagnosticFailure)
        c.queueDiagnostic("visit.checkOut", "other", null, "nonproductive", null).join()
        c.openDiagnostic(next).join()
        c.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        assertEquals(3, b.calls.size)
        assertNull(c.diagnosticFailure)
        assertTrue(org.json.JSONObject(b.calls.first().first.serializedOperation).getJSONObject("payload").isNull("location"))
    }
    @Test fun uiStateChangesStayOnConfiguredUiDispatcherWhileBackendUsesIo() = runBlocking {
        val uiThread = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "field-ui-test") }
        val ioThread = java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "field-io-test") }
        val ui = uiThread.asCoroutineDispatcher()
        val io = ioThread.asCoroutineDispatcher()
        val writes = java.util.concurrent.CopyOnWriteArrayList<String>()
        val observer = androidx.compose.runtime.snapshots.Snapshot.registerGlobalWriteObserver { writes += Thread.currentThread().name }
        try {
            val backend = FakeBackend()
            var callbackThread: String? = null
            val c = FieldController(backend, this, io, ui) { callbackThread = Thread.currentThread().name }
            c.start(configured = false).join()
            assertTrue(callbackThread!!.startsWith("field-io-test"))
            c.openDiagnostic(VisitDisplay("Store", "Planned", "Scheduled")).join()
            c.closeDiagnostic().join()
            assertNull(c.diagnostic)
            assertTrue(writes.isNotEmpty())
            assertTrue(writes.all { it.startsWith("field-ui-test") })
        } finally { observer.dispose(); ui.close(); io.close() }
    }
    @Test fun pillMapping() {
        assertEquals(StatusPill.OFFLINE, StatusPill.of(EnrollmentState.SignedOut))
        assertEquals(StatusPill.UNREGISTERED, StatusPill.of(EnrollmentState.Unregistered))
        assertEquals(StatusPill.READY, StatusPill.of(EnrollmentState.Ready("d")))
        assertEquals(StatusPill.REMOVED, StatusPill.of(EnrollmentState.Removed))
        assertEquals("Offline", StatusPill.OFFLINE.label)
        assertEquals("Waiting for admin", StatusPill.UNREGISTERED.label)
        assertEquals(SunprideTokens.yellow, StatusPill.OFFLINE.background)
        assertEquals(SunprideTokens.yellow, StatusPill.UNREGISTERED.background)
    }
}
