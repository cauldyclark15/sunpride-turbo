package com.sunpride.field.ui.diagnosticvisit

import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.assertIsNotEnabled
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
    private inner class Backend(private val plans: List<VisitDisplay> = listOf(
        VisitDisplay("Test outlet", "Planned", "Scheduled", "outlet-1", "planned-1")),
        private val unplanned: List<VisitDisplay> = emptyList()) : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = identity.deviceId
        override fun loadSigner(): DeviceSigner = KeystoreDeviceKey.loadOrCreate(context, alias)
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(identity.deviceId)
        override fun today(deviceId: String, signer: DeviceSigner, sync: Boolean) = TodayData(
            plans,
            stale = true, queuedCount = visitStates().count { it.second == "pending" }, unplannedOutlets = unplanned,
            syncStatus = com.sunpride.field.ui.syncstatus.SyncStatus(queued = visitStates().count { it.second == "pending" }))
        override fun visitStates(): List<Pair<IntentRow, String>> {
            val store = scoped()
            return try { runBlocking { store.history().map { it.first to it.second.state } } }
            finally { store.close() }
        }
        override fun callSheet(outletId: String): CallSheet? {
            val store = scoped()
            return try { runBlocking { store.callSheet(outletId) } } finally { store.close() }
        }
        override fun queueCallSheet(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
            outletId: String, drafts: List<CallSheetDraftLine>) {
            val store = scoped()
            try { runBlocking {
                val sheet = store.callSheet(outletId) ?: error("No call sheet")
                store.enqueue(VisitIntentFactory.create(identity, "visit.activity", clientVisitId, checkInRequestId,
                    previousRequestId, null, outletId, emptyList(), null, null, null, null, null,
                    callSheet = CallSheetPayload.activity(sheet, drafts)), System.currentTimeMillis())
            } } finally { store.close() }
        }
        override fun activityRules(): List<ActivityRule> {
            val store = scoped()
            return try { runBlocking { store.activityRules() } } finally { store.close() }
        }
        override fun queueActivity(clientVisitId: String, checkInRequestId: String, previousRequestId: String,
            outletId: String, activity: JSONObject) {
            val store = scoped()
            try { runBlocking {
                store.enqueue(VisitIntentFactory.create(identity, "visit.activity", clientVisitId, checkInRequestId,
                    previousRequestId, null, outletId, emptyList(), null, null, null, null, null, activity = activity),
                    System.currentTimeMillis())
            } } finally { store.close() }
        }
        val photoFiles = com.sunpride.field.evidence.KeystorePhotoFiles(context, "diagnostic-photo-ui-test")
        override fun photoTypes(): List<PhotoType> {
            val store = scoped()
            return try { runBlocking { store.photoTypes() } } finally { store.close() }
        }
        override fun visitPhotos(clientVisitId: String): List<VisitPhoto> {
            val store = scoped()
            return try { runBlocking { store.visitPhotos(clientVisitId).map { EvidencePhotos.view(it) } } } finally { store.close() }
        }
        override fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
            jpeg: ByteArray, capturedAt: Long) {
            val id = UUID.randomUUID().toString()
            photoFiles.write(id, jpeg)
            val store = scoped()
            try { runBlocking {
                store.addPhoto(EvidencePhotoRow(identity.account, identity.deviceId, identity.fingerprint, id,
                    clientVisitId, checkInRequestId, outletId, photoType, EvidencePhotos.MIME, jpeg.size.toLong(),
                    EvidencePhotos.sha256Hex(jpeg), capturedAt, System.currentTimeMillis()), System.currentTimeMillis())
            } } finally { store.close() }
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
    @Test fun enterAndSaveCallSheetOfflineAndSaveAgain() {
        val sheet = CallSheet("outlet-1", 1, CallSheetHeader("Test account", "Sample address", "Buyer",
            "Contact", "Account lead", null, "Distributor", "Tuesday", null, "SRP"),
            listOf(CallSheetProduct("product-1", "SKU-1", "Test product", "PC", null, "₱10"),
                CallSheetProduct("product-2", "SKU-2", "Untouched product", "CAN", null, null)))
        val store = scoped()
        runBlocking {
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"test\"}", null, emptyList(), emptyList(),
                emptyList(), emptyList(), listOf(sheet))), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        }
        store.close()
        val backend = Backend()
        val location = object : VisitLocation {
            override val requiresPermission = false
            override suspend fun fix(): JSONObject? = null
        }
        rule.setContent { FieldApp(AppEnvironment("https://team.convex.site", "https://team.convex.cloud"),
            dark = false, debug = true, backend = backend, visitLocation = location) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-open").performScrollTo().performClick()
        // Inject a check-in without requesting or granting any device permission.
        backend.queueVisit("visit.checkIn", null, null, null, "planned-1", "outlet-1", emptyList(), null, null, null, null, null)
        rule.onNodeWithTag("visit-back").performClick()
        rule.onNodeWithTag("diagnostic-open").performScrollTo().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("call-sheet-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("call-sheet-open").performScrollTo().performClick()
        rule.onNodeWithTag("call-sheet-save").assertIsNotEnabled()
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-product-1-order"))
        // Fields stay disabled while the app's own start-up refresh is still running.
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("call-sheet-product-1-order").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("call-sheet-product-1-order").performTextInput("24")
        rule.onNodeWithTag("call-sheet-product-1-beginningInventory").performTextInput("0")
        androidx.test.espresso.Espresso.pressBack()
        rule.onNodeWithTag("call-sheet-save").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { backend.visitStates().count { it.first.kind == "visit.activity" } == 1 }
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-status"))
        rule.onNodeWithTag("call-sheet-status").assertTextContains("Queued", substring = true)
        rule.onNodeWithTag("call-sheet-save").assertIsNotEnabled()
        val reopened = scoped()
        try { runBlocking {
            val activity = JSONObject(reopened.history().last().first.serializedOperation).getJSONObject("payload").getJSONObject("activity")
            assertEquals("call_sheet", activity.getString("kind"))
            assertEquals(1, activity.getJSONArray("lines").length())
            val line = activity.getJSONArray("lines").getJSONObject(0)
            assertEquals(24, line.getInt("order")); assertEquals(0, line.getInt("beginningInventory"))
            assertEquals(JSONObject.NULL, line.get("take"))
        } } finally { reopened.close() }
        rule.onNodeWithTag("call-sheet-products").performScrollToNode(hasTestTag("call-sheet-product-1-order"))
        // Inputs re-enable once the save finishes re-reading the call (busy covers the whole save).
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("call-sheet-product-1-order").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("call-sheet-product-1-order").performTextInput("5")
        androidx.test.espresso.Espresso.pressBack()
        rule.onNodeWithTag("call-sheet-save").performClick()
        rule.waitUntil(10_000) { backend.visitStates().count { it.first.kind == "visit.activity" } == 2 }
    }
    @After fun cleanup() {
        KeystoreDeviceKey.delete(alias)
        PhotoCameraSeam.fake = null
        java.security.KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry("diagnostic-photo-ui-test")
    }
    /** AND-016: a typed photo is sealed on the phone during the call and End does not wait for its upload. */
    @Test fun visitPhotoIsSavedOfflineAndEndIsNotBlocked() {
        val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3, 0xFF.toByte(), 0xD9.toByte())
        PhotoCameraSeam.fake = { jpeg }
        val store = scoped()
        runBlocking {
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"test\"}", null, emptyList(), emptyList(),
                emptyList(), emptyList(), photoTypes = listOf(PhotoType("storefront", "Store front"),
                    PhotoType("shelf_display", "Shelf and display")))), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        }
        store.close()
        val backend = Backend()
        val location = object : VisitLocation {
            override val requiresPermission = false
            override suspend fun fix(): JSONObject? = null
        }
        rule.setContent { FieldApp(AppEnvironment("https://team.convex.site", "https://team.convex.cloud"),
            dark = false, debug = true, backend = backend, visitLocation = location) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-open").performScrollTo().performClick()
        rule.onNodeWithTag("photo-open").assertDoesNotExist() // no photos before Start
        backend.queueVisit("visit.checkIn", null, null, null, "planned-1", "outlet-1", emptyList(), null, null, null, null, null)
        rule.onNodeWithTag("visit-back").performClick()
        rule.onNodeWithTag("diagnostic-open").performScrollTo().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("photo-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("photo-open").performScrollTo().performClick()
        rule.onNodeWithTag("photo-take").assertIsNotEnabled() // type first
        rule.onNodeWithTag("photo-type-shelf_display").performScrollTo().performClick()
        rule.onNodeWithTag("photo-take").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("visit-photo").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("visit-photo").performScrollTo().assertTextContains("Shelf and display", substring = true)
        rule.onNodeWithTag("visit-photo").assertTextContains("Saved on phone", substring = true)
        val saved = scoped()
        val row = try { runBlocking { saved.pendingPhotos().single() } } finally { saved.close() }
        assertEquals("shelf_display", row.photoType)
        assertEquals(EvidencePhotos.sha256Hex(jpeg), row.sha256)
        org.junit.Assert.assertArrayEquals(jpeg, backend.photoFiles.read(row.localId))
        assertEquals(listOf("visit.checkIn"), backend.visitStates().map { it.first.kind })
        // End with the photo still waiting (no network in this test): nothing blocks it.
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick() // completed
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkout").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-confirm-end").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        rule.waitUntil(10_000) { backend.visitStates().any { it.first.kind == "visit.checkOut" } }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("result-photos").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("result-photos").performScrollTo().assertTextContains("1 waiting to upload", substring = true)
        rule.onNodeWithTag("photo-open").assertDoesNotExist() // no new photos after End
        backend.photoFiles.delete(row.localId)
    }
    /** AND-013: an unplanned multi-purpose visit fills the backend-required forms before a completed End. */
    @Test fun unplannedMultiIntentVisitRequiresRuleFormsBeforeCompletedEnd() {
        val rules = listOf(
            ActivityRule("merchandise", "rule:1", listOf(RuleActivity("merchandising", true), RuleActivity("price_check", false))),
            ActivityRule("complaint", "rule:2", listOf(RuleActivity("note", true))))
        val store = scoped()
        runBlocking {
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"test\"}", null, emptyList(), emptyList(), emptyList(),
                emptyList(), activityRules = rules)), "cursor", System.currentTimeMillis() + 120_000,
                System.currentTimeMillis() + 120_000)
            assertEquals(rules, store.activityRules()) // survives Room staging/promotion
        }
        store.close()
        val backend = Backend(emptyList(), listOf(VisitDisplay("Walk-in outlet", "Unplanned", "Reason required", "outlet-9")))
        val location = object : VisitLocation { override val requiresPermission = false; override suspend fun fix(): JSONObject? = null }
        rule.setContent { FieldApp(AppEnvironment("https://team.convex.site", "https://team.convex.cloud"),
            dark = false, debug = true, backend = backend, visitLocation = location) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("unplanned-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("unplanned-open").performScrollTo().performClick()
        rule.onNodeWithTag("unplanned-reason").performScrollTo().performTextInput("Buyer called")
        androidx.test.espresso.Espresso.pressBack()
        rule.onNodeWithTag("diagnostic-checkin").assertIsNotEnabled() // no purpose chosen yet
        rule.onNodeWithTag("intent-merchandise").performScrollTo().performClick()
        rule.onNodeWithTag("intent-complaint").performScrollTo().performClick()
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkin").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 1 }
        val start = JSONObject(backend.visitStates().single().first.serializedOperation).getJSONObject("payload")
        assertEquals("""["merchandise","complaint"]""", start.getJSONArray("intents").toString())
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("activity-merchandising").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("visit-intents").assertTextContains("Merchandise, Complaint", substring = true)
        rule.onNodeWithTag("activity-note").assertTextContains("Required", substring = true)
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick() // completed
        rule.onNodeWithTag("activities-missing").performScrollTo().assertTextContains("Merchandising", substring = true)
        rule.onNodeWithTag("diagnostic-checkout").assertIsNotEnabled()
        rule.onNodeWithTag("activity-merchandising").performScrollTo().performClick()
        rule.onNodeWithTag("activity-form-title").assertTextContains("Merchandising")
        rule.onNodeWithTag("activity-save").assertIsNotEnabled()
        rule.onNodeWithTag("activity-display-needs_action").performScrollTo().performClick()
        rule.onNodeWithTag("activity-text").performScrollTo().performTextInput("Re-faced shelf")
        androidx.test.espresso.Espresso.pressBack()
        rule.onNodeWithTag("activity-save").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 2 }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-note").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-note").performScrollTo().performTextInput("Damaged cans reported")
        androidx.test.espresso.Espresso.closeSoftKeyboard()
        rule.onNodeWithTag("diagnostic-add-note").performScrollTo().performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 3 }
        // The outcome is chosen on the visit screen; opening a form screen leaves it, so choose again.
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick() // completed
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkout").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("activities-missing").assertDoesNotExist()
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        // AND-017: End is reviewed first; nothing is queued until the person confirms.
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("end-review").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("end-review-activities").performScrollTo().assertTextContains("Merchandising, Note", substring = true)
        assertEquals(3, backend.visitStates().size)
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 4 }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("visit-result").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("result-outcome").performScrollTo().assertTextContains("Completed", substring = true)
        rule.onNodeWithTag("diagnostic-note").assertDoesNotExist() // final: nothing more can be added
        val activity = JSONObject(backend.visitStates()[1].first.serializedOperation).getJSONObject("payload").getJSONObject("activity")
        assertEquals(mapOf("kind" to "merchandising", "displayCondition" to "needs_action", "actionTaken" to "Re-faced shelf"),
            activity.keys().asSequence().associateWith { activity.get(it) })
        assertEquals(listOf("visit.checkIn", "visit.activity", "visit.activity", "visit.checkOut"),
            backend.visitStates().map { it.first.kind })
    }
    @Test fun queuesCheckInAndCheckOutOfflineWithoutPhoneLocationPermission() = runScenario(false)
    @Test fun darkVisitScreenshot() = runScenario(true)
    @Test fun nextStoreStartIsDisabledUntilCurrentCallEndsWithProductivity() {
        val first = VisitDisplay("First", "Planned", "Scheduled", "first", "p-first", sequence = 0)
        val next = VisitDisplay("Next", "Planned", "Scheduled", "next", "p-next", sequence = 1)
        val backend = Backend(listOf(next, first))
        val store = scoped()
        val day = java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).toString()
        runBlocking {
            val plans = listOf(next, first).map { v -> SnapshotItem(v.plannedVisitId!!, JSONObject()
                .put("id", v.plannedVisitId).put("outletId", v.outletId).put("serviceDate", day)
                .put("sequence", v.sequence).toString(), day) }
            store.swap(store.stage(ScopedSnapshot("{}", null, plans, emptyList(), emptyList(), emptyList())),
                "cursor", System.currentTimeMillis() + 120_000, System.currentTimeMillis() + 120_000)
        }
        store.close()
        val location = object : VisitLocation { override val requiresPermission = false; override suspend fun fix(): JSONObject? = null }
        rule.setContent { FieldApp(AppEnvironment("https://team.convex.site", "https://team.convex.cloud"),
            dark = false, debug = true, backend = backend, visitLocation = location) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-open").fetchSemanticsNodes().size == 2 }
        rule.onAllNodesWithTag("diagnostic-open")[0].assertTextContains("First", substring = true)
        rule.onAllNodesWithTag("diagnostic-open")[1].performScrollTo().performClick()
        rule.onNodeWithTag("diagnostic-checkin").assertIsNotEnabled()
        rule.onNodeWithTag("start-blocked").assertTextContains("Visit stores in plan order")
        rule.onNodeWithTag("visit-back").performClick()
        rule.onAllNodesWithTag("diagnostic-open")[0].performScrollTo().performClick()
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 1 }
        rule.onNodeWithTag("visit-back").performClick()
        rule.onAllNodesWithTag("diagnostic-open")[1].performScrollTo().performClick()
        rule.onNodeWithTag("diagnostic-checkin").assertIsNotEnabled()
        rule.onNodeWithTag("start-blocked").assertTextContains("Finish the open call first")
        rule.onNodeWithTag("visit-back").performClick()
        rule.onAllNodesWithTag("diagnostic-open")[0].performScrollTo().performClick()
        rule.onNodeWithTag("diagnostic-checkout").assertIsNotEnabled()
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick() // completed
        rule.onNodeWithTag("diagnostic-outcome").performClick() // nonproductive
        rule.onNodeWithTag("diagnostic-checkout").assertIsNotEnabled()
        rule.onNodeWithTag("diagnostic-reason").performScrollTo().performTextInput("other")
        androidx.test.espresso.Espresso.pressBack()
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-confirm-end").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("end-review-outcome").performScrollTo().assertTextContains("Not productive · other", substring = true)
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        rule.waitUntil(10_000) { backend.visitStates().size == 2 }
        rule.onNodeWithTag("visit-back").performClick()
        rule.onAllNodesWithTag("diagnostic-open")[1].performScrollTo().performClick()
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkin").assertIsEnabled() }.isSuccess }
    }
    @Test fun missingLocationNeverBlocksStartOrEnd() = runScenario(false, missingFix = true)
    @Test fun realFusedCaptureReportsMissingPermissionInsteadOfFailing() = runBlocking {
        // The test APK is never granted location; the real capture must explain why there is no fix.
        org.junit.Assume.assumeTrue(androidx.core.content.ContextCompat.checkSelfPermission(context,
            android.Manifest.permission.ACCESS_COARSE_LOCATION) != android.content.pm.PackageManager.PERMISSION_GRANTED)
        assertEquals(LocationCapture.Unavailable(UnavailableReason.PERMISSION_DENIED),
            AndroidVisitLocation(context).captureOrUnavailable())
    }
    private fun runScenario(dark: Boolean, missingFix: Boolean = false) {
        val store = scoped()
        runBlocking {
            store.swap(store.stage(ScopedSnapshot("{\"id\":\"test\"}", null, emptyList(), emptyList(), emptyList(), emptyList())),
                "cursor", System.currentTimeMillis() + 120_000, System.currentTimeMillis() + 120_000)
        }
        store.close()
        val location = object : VisitLocation {
            override val requiresPermission = false
            override suspend fun fix(): JSONObject? = if (missingFix) null else JSONObject().put("latitude", 0).put("longitude", 0)
                .put("accuracyMeters", 10).put("fixTime", System.currentTimeMillis())
                .put("provider", "gps").put("mockSignal", true)
        }
        rule.setContent { FieldApp(AppEnvironment("https://team.convex.site", "https://team.convex.cloud"),
            dark = dark, debug = true, backend = Backend(), visitLocation = location) }
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-open").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-open").performScrollTo().performClick()
        rule.runOnUiThread {
            androidx.core.view.WindowCompat.getInsetsController(rule.activity.window,
                rule.activity.window.decorView).isAppearanceLightStatusBars = !dark
        }
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkin").assertIsEnabled() }.isSuccess }
        rule.waitForIdle()
        Thread.sleep(350)
        com.sunpride.field.captureCalmScreenshot("${if (dark) "dark" else "light"}-visit-before")
        rule.onNodeWithText("Planned · Not started").assertExists()
        rule.onNodeWithTag("unplanned-toggle").assertDoesNotExist()
        rule.onNodeWithTag("diagnostic-checkin").assertTextContains("Start").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-operation").fetchSemanticsNodes().size == 1 }
        rule.onNodeWithTag("diagnostic-operation").assertTextContains("Waiting", substring = true)
        // The mock/missing fix is recorded and flagged for review; Start was never refused.
        rule.onNodeWithTag("location-review").performScrollTo().assertTextContains(
            if (missingFix) "Location unavailable · supervisor will review" else "mock location detected", substring = true)
        rule.onNodeWithTag("diagnostic-checkout").assertTextContains("End call").assertIsNotEnabled()
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick()
        rule.waitUntil(10_000) { runCatching { rule.onNodeWithTag("diagnostic-checkout").assertIsEnabled() }.isSuccess }
        rule.onNodeWithTag("diagnostic-note").performTextInput("Stock checked")
        rule.onNodeWithTag("diagnostic-add-note").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-operation").fetchSemanticsNodes().size == 2 }
        androidx.test.espresso.Espresso.pressBack()
        rule.waitForIdle()
        Thread.sleep(350)
        com.sunpride.field.captureCalmScreenshot("${if (dark) "dark" else "light"}-visit-queued-top")
        rule.onNodeWithTag("visit-bottom-space").performScrollTo()
        rule.runOnUiThread {
            androidx.core.view.WindowCompat.getInsetsController(rule.activity.window,
                rule.activity.window.decorView).isAppearanceLightStatusBars = !dark
        }
        rule.waitForIdle()
        Thread.sleep(350)
        com.sunpride.field.captureCalmScreenshot("${if (dark) "dark" else "light"}-visit-queued")
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-confirm-end").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("end-review-back").performClick() // Back keeps the call open and queues nothing
        rule.onNodeWithTag("end-review").assertDoesNotExist()
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-confirm-end").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("diagnostic-operation").fetchSemanticsNodes().size == 3 }
        val reopened = scoped()
        try {
            val history = runBlocking { reopened.history() }
            assertEquals(3, history.size)
            for ((intent, _) in history.filter { it.first.kind != "visit.activity" }) {
                val payload = JSONObject(intent.serializedOperation).getJSONObject("payload")
                if (missingFix) org.junit.Assert.assertTrue(payload.isNull("location"))
                else assertEquals("gps", payload.getJSONObject("location").getString("provider"))
            }
        } finally { reopened.close() }
        rule.onNodeWithTag("call-time-spent").performScrollTo().assertTextContains("min", substring = true)
        // The End fix (mock or missing) is shown on the final record as flagged for review.
        rule.onNodeWithTag("result-location-review").performScrollTo().assertTextContains(
            if (missingFix) "End location unavailable" else "mock location detected", substring = true)
        rule.onNodeWithTag("result-sync").assertTextContains("Waiting to send", substring = true)
    }
}
