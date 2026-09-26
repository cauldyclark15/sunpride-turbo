package com.sunpride.field.ui.diagnosticvisit

import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.storage.*
import com.sunpride.field.ui.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import java.util.UUID

class DiagnosticVisitTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    private val identity = StoreScope("test|${UUID.randomUUID()}", "test-device", "test-scope")
    private val alias = "diagnostic-visit-ui-test"
    private val context get() = rule.activity
    private fun scoped(): RoomFieldStore = RoomFieldStore(EncryptedFieldDatabase.open(context), identity)
    private inner class Backend : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = identity.deviceId
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(context, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(identity.deviceId)
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(
            listOf(VisitDisplay("Test outlet", "Planned", "Scheduled", "outlet-1", "planned-1")),
            stale = true, queuedCount = visitStates().count { it.second == "pending" })
        override fun visitStates(): List<Pair<IntentRow, String>> {
            val store = scoped()
            return try { runBlocking { store.history().map { it.first to it.second.state } } }
            finally { store.close() }
        }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) {
            val store = scoped()
            try { runBlocking {
                store.enqueue(VisitIntentFactory.create(identity, kind, clientVisitId, checkInRequestId,
                    previousRequestId, plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode,
                    location), System.currentTimeMillis())
            } } finally { store.close() }
        }
    }
    @After fun cleanup() { KeystoreDeviceKey.delete(alias) }
    @Test fun queuesCheckInAndCheckOutOfflineWithoutPhoneLocationPermission() {
        val store = scoped()
        runBlocking {
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"test\"}", null, emptyList(), emptyList(), emptyList(), emptyList())),
                "cursor", System.currentTimeMillis() + 120_000, System.currentTimeMillis() + 120_000)
        }
        store.close()
        val location = object : VisitLocation {
            override val requiresPermission = false
            override suspend fun fix() = JSONObject().put("latitude", 0).put("longitude", 0)
                .put("accuracyMeters", 10).put("fixTime", System.currentTimeMillis())
                .put("provider", "gps").put("mockSignal", true)
        }
        rule.setContent { FieldApp(AppEnvironment("https://team.convex.site", "https://team.convex.cloud"),
            dark = false, debug = true, backend = Backend(), visitLocation = location) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-open").performClick()
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-operation").fetchSemanticsNodes().size == 1 }
        rule.onNodeWithTag("diagnostic-operation").assertTextContains("Queued", substring = true)
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkout").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("diagnostic-checkout").performScrollTo().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-operation").fetchSemanticsNodes().size == 2 }
        val reopened = scoped()
        try { assertEquals(2, runBlocking { reopened.pending().size }) }
        finally { reopened.close() }
    }
}
