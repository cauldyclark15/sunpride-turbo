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
        var todayAction: (() -> TodayData)? = null
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
            todayAction?.let { return it() }
            todayResult?.let { return it }
            return if (sync) TodayData(lastSynced = 150, stale = false) else TodayData()
        }
        override val isSignedIn get() = signedIn
        override fun loadSigner(): DeviceSigner = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.STRONGBOX)
        override fun signIn(email: String, password: String) { signInError?.let { throw it }; signedIn = true }
        override fun signOut() { signOuts++; signedIn = false }
        var passwordCalls = 0
        var passwordFailure: Exception? = null
        override fun changePassword(current: String, next: String, confirm: String) {
            passwordCalls++; passwordFailure?.let { throw it }
        }
        override fun refreshEnrollment(signer: DeviceSigner) = results.removeFirst()()
        var endedReason: String? = null
        override fun endedSessionReason() = endedReason
        var unsent = 0
        override fun unsentOnPhone() = unsent
        val teamCalls = mutableListOf<Boolean>()
        var teamError: Exception? = null
        override fun team(directOnly: Boolean): com.sunpride.field.ui.team.TeamView {
            teamCalls += directOnly
            teamError?.let { throw it }
            return com.sunpride.field.ui.team.TeamView(message = if (directOnly) "direct" else "all")
        }
    }

    private fun run(block: suspend (FieldController, FakeBackend, MutableList<DeviceKeyInfo>) -> Unit) = runBlocking {
        val backend = FakeBackend()
        val exported = mutableListOf<DeviceKeyInfo>()
        val controller = FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext) { exported += it }
        block(controller, backend, exported)
    }

    // F-209/F-222: on an offline cold start the screen reads `workforce` before the store load lands.
    // That first read must subscribe to the loaded data, or the saved grant and queue never appear.
    @Test fun `F-209_F-222 workforce read before the first load observes the later load`() = run { c, b, _ ->
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "fake").join()
        val reads = mutableSetOf<Any>()
        val observe = androidx.compose.runtime.snapshots.Snapshot.takeSnapshot { reads += it }
        try { observe.enter { assertTrue(c.workforce.entries.isEmpty()) } } finally { observe.dispose() }
        val writes = mutableSetOf<Any>()
        val handle = androidx.compose.runtime.snapshots.Snapshot.registerApplyObserver { changed, _ -> writes.addAll(changed) }
        try {
            c.reloadWorkforce().join()
            androidx.compose.runtime.snapshots.Snapshot.sendApplyNotifications()
        } finally { handle.dispose() }
        assertTrue("a pre-load read must be invalidated by the load", reads.any { it in writes })
    }

    @Test fun delayedTodayCannotRepopulateTheScreenAfterRealControllerSignOut() = runBlocking {
        val b = FakeBackend()
        val c = FieldController(b, this, Dispatchers.IO, EmptyCoroutineContext)
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "fake").join()
        val entered = java.util.concurrent.CountDownLatch(1)
        val release = java.util.concurrent.CountDownLatch(1)
        b.todayAction = {
            entered.countDown()
            check(release.await(5, java.util.concurrent.TimeUnit.SECONDS))
            TodayData(visits = listOf(VisitDisplay("Private earlier account", "Planned", "Done")))
        }
        val pending = c.syncNow()
        kotlinx.coroutines.withContext(Dispatchers.IO) { check(entered.await(5, java.util.concurrent.TimeUnit.SECONDS)) }
        c.signOut().join()
        release.countDown(); pending.join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertTrue(c.today.visits.isEmpty())
    }

    @Test fun passwordChangeKeepsReadyAndReportsFixedErrorOrSuccess() = run { c, b, _ ->
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "fake").join()
        b.passwordFailure = com.sunpride.field.auth.PasswordChangeFailure(
            com.sunpride.field.auth.PasswordChangeFailure.Kind.WRONG_CURRENT)
        c.changePassword("wrong-fake", "new-fake", "new-fake").join()
        assertEquals("Your current password is incorrect.", c.passwordMessage)
        assertFalse(c.passwordChanged)
        b.passwordFailure = null
        var callbacks = 0
        c.changePassword("old-fake", "new-fake", "new-fake") { callbacks++ }.join()
        assertEquals(1, callbacks)
        assertEquals(EnrollmentState.Ready("dev1"), c.state)
        assertTrue(c.passwordChanged)
        assertFalse(c.passwordBusy)
        assertEquals(com.sunpride.field.auth.PasswordChange.SUCCESS, c.passwordMessage)
    }

    @Test fun serverRecordedEarlierStopPassesThroughControllerStartValidation() = run { c, b, _ ->
        val prior = VisitDisplay("Earlier store", "Planned", "Done", "one", "plan-one", sequence = 0,
            serverExecution = org.json.JSONObject().put("state", "checked-out").toString())
        val next = VisitDisplay("Next customer", "Planned", "Scheduled", "two", "plan-two", sequence = 1)
        b.todayResult = TodayData(visits = listOf(prior, next))
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "fake").join()
        assertNull(c.startFailure(next))
        assertEquals(com.sunpride.field.storage.VisitRuleFailure.Code.ALREADY_ENDED, c.startFailure(prior)?.code)
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

    // FLD-014/FLD-171: a session ended by the background sync (phone revoked, password changed elsewhere) used to
    // leave the app inside on an empty Today. It now returns to Sign in with the plain reason and clears nothing.
    @Test fun `FLD-014 ended session found by a reload returns to sign in with the reason and keeps data`() = run { c, b, _ ->
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "p").join()
        assertEquals(EnrollmentState.Ready("dev1"), c.state)
        b.todayAction = { throw sessionEndedFailure(removed = true) }
        c.backgroundSyncFinished().join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals(AuthFailure.PHONE_REMOVED, c.error)
        assertEquals("local work is never torn down on an ended session", 0, b.signOuts)
    }

    // FLD-014/E2E-004: the queued check-in stays visible as unsent work after the office removed the phone, both when
    // the sync finds the session ended and when signing in again on the removed phone is refused.
    @Test fun `FLD-014 removed phone shows the unsent count on sign in and refused sign-in`() = run { c, b, _ ->
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "p").join()
        b.unsent = 1
        b.todayAction = { throw sessionEndedFailure(removed = true) }
        c.syncNow().join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals(AuthFailure.PHONE_REMOVED, c.error)
        assertEquals(1, c.unsentOnPhone)
        b.unsent = 2
        b.signInError = AuthFailure(AuthFailure.Kind.REFUSED, removed = true)
        c.signIn("a@example.test", "p").join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals(AuthFailure.PHONE_REMOVED, c.error)
        assertEquals(2, c.unsentOnPhone)
        assertEquals(0, b.signOuts)
    }

    @Test fun `FLD-171 sync now after a password change elsewhere says the session ended`() = run { c, b, _ ->
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "p").join()
        b.todayAction = { throw sessionEndedFailure(removed = false) }
        c.syncNow().join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals("Your session has ended. Sign in again.", c.error)
        assertEquals(0, b.signOuts)
        assertTrue(c.today.visits.isEmpty())
    }

    @Test fun `FLD-171 relaunch after an ended session still shows the reason`() = run { c, b, _ ->
        b.endedReason = "Your session has ended. Sign in again."
        c.start().join()
        assertEquals(EnrollmentState.SignedOut, c.state)
        assertEquals("Your session has ended. Sign in again.", c.error)
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

    @Test fun teamLoadsOnlyWhenReadyAndKeepsTheChosenFilter() = run { c, b, _ ->
        c.loadTeam().join()
        assertTrue(b.teamCalls.isEmpty()) // signed out: never asks the server
        b.results += { EnrollmentState.Ready("dev1") }
        c.signIn("a@example.test", "fake").join()
        c.loadTeam().join()
        assertEquals(listOf(true), b.teamCalls)
        assertEquals("direct", c.team.message)
        c.loadTeam(false).join()
        assertFalse(c.teamDirectOnly)
        assertEquals("all", c.team.message)
        b.teamError = IllegalStateException("boom")
        c.loadTeam().join()
        assertEquals(listOf(true, false, false), b.teamCalls)
        assertEquals("Couldn't load your team. Try again.", c.team.message)
        assertFalse(c.teamLoading)
        c.signOut().join()
        assertTrue(c.teamDirectOnly)
        assertNull(c.team.message)
    }
}
