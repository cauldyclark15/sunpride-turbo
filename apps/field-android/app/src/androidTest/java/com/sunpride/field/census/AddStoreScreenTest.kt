package com.sunpride.field.census

import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.statusBarsPadding
import android.Manifest
import android.graphics.Bitmap
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.customers.CustomerRecord
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.UUID

/** SP-0163 Add a store on a real phone, against a fake API (no network, no Google key). Screenshots go to the dev
 * app's private files/cg-shots (pull with run-as). */
class AddStoreScreenTest {
    @get:Rule val rule = createAndroidComposeRule<androidx.activity.ComponentActivity>()
    @org.junit.Before fun grantCamera() {
        val i = InstrumentationRegistry.getInstrumentation(); i.uiAutomation.grantRuntimePermission(i.targetContext.packageName, Manifest.permission.CAMERA)
    }

    private val batch = UUID.randomUUID().toString(); private val channel = UUID.randomUUID().toString(); private val sub = UUID.randomUUID().toString()
    private fun config(search: Boolean) = JSONObject().put("addressSearch", search)
        .put("defaultBatch", JSONObject().put("id", batch).put("name", "Ongoing store gathering"))
        .put("batches", org.json.JSONArray().put(JSONObject().put("id", batch).put("name", "Ongoing store gathering")))
        .put("channels", org.json.JSONArray().put(JSONObject().put("id", channel).put("label", "General trade")))
        .put("subchannels", org.json.JSONArray().put(JSONObject().put("id", sub).put("label", "Sari-sari").put("data", JSONObject().put("channelId", channel))))

    private class Backend(val cfg: JSONObject, val places: CensusPlaces) : FieldBackend {
        val queued = mutableListOf<JSONObject>()
        override val isSignedIn = true
        override fun loadSigner(): DeviceSigner = error("unused")
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.SignedOut
        override fun censusConfig() = cfg
        override fun censusPlaces() = places
        override fun queueCensus(payload: JSONObject) { CensusRules.validate(payload); queued += payload }
    }
    private val gps = object : VisitLocation {
        override val requiresPermission = false
        override suspend fun fix(): JSONObject = JSONObject().put("latitude", 10.3157).put("longitude", 123.8854).put("accuracyMeters", 12.0)
            .put("fixTime", System.currentTimeMillis()).put("provider", "fused").put("mockSignal", false)
    }
    private val online = CensusPlaces({ path -> when {
        path.startsWith("/api/v1/places/reverse") -> JSONObject("""{"formattedAddress":"12 Colon St, Cebu City","components":{"barangay":"Kalubihan","city":"Cebu City"}}""")
        path.startsWith("/api/v1/places/autocomplete") -> JSONObject("""{"predictions":[{"placeId":"P-sm","primary":"SM Seaside City Cebu","secondary":"Cebu South Coastal Road, Cebu City","description":"SM Seaside City Cebu"}]}""")
        path.startsWith("/api/v1/places/details") -> JSONObject("""{"placeId":"P-sm","formattedAddress":"Cebu South Coastal Rd, Cebu City","latitude":10.2817,"longitude":123.8805,"components":{"barangay":"Mambaling","city":"Cebu City"}}""")
        else -> throw AuthFailure(AuthFailure.Kind.SERVER) } },
        { _, _ -> JSONObject("""{"candidates":[],"truncated":false}""") })
    private val oldServer = CensusPlaces({ throw com.sunpride.field.auth.ServerError(null) }, { _, _ -> throw com.sunpride.field.auth.ServerError(null) })
    private val stores = listOf(CustomerRecord("o1", "ALING NENA STORE", address = "Colon St", latitude = 10.31585, longitude = 123.88545))

    private fun shot(name: String) {
        rule.waitForIdle(); Thread.sleep(500)
        val bmp = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: return
        val dir = File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "cg-shots").apply { mkdirs() }
        File(dir, "android-$name.png").outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
    private fun waitTag(tag: String, ms: Long = 10_000) = rule.waitUntil(ms) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun show(backend: Backend, opened: MutableList<String> = mutableListOf()) = rule.setContent {
        MaterialTheme(colorScheme = SunprideTokens.lightColors) { CensusScreen(backend, gps, {}, stores = stores, onOpenStore = { opened += it }) }
    }

    @Test fun useMyLocationFillsAddressAndSearchPicksAPlace() {
        val backend = Backend(config(true), online); show(backend)
        waitTag("census-gps"); assertTrue(rule.onAllNodesWithTag("census-batch").fetchSemanticsNodes().isEmpty())
        shot("01-add-store")
        rule.onNodeWithTag("census-gps").performScrollTo().performClick()
        waitTag("census-accuracy"); rule.onNodeWithTag("census-accuracy").assertTextContains("±12 m", substring = true)
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("census-address-line").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("census-address").assertTextContains("12 Colon St, Cebu City")
        shot("02-use-my-location")
        rule.onNodeWithTag("census-search-mode").performScrollTo().performClick()
        rule.onNodeWithTag("census-search").performScrollTo().performTextInput("SM Sea")
        waitTag("census-suggestion"); shot("03-search-suggestions")
        rule.onAllNodesWithTag("census-suggestion")[0].performScrollTo().performClick()
        waitTag("census-pin-from-address"); rule.onNodeWithTag("census-address").assertTextContains("Cebu South Coastal Rd, Cebu City")
        rule.onNodeWithTag("census-landmark").performScrollTo().performTextInput("beside the chapel")
        shot("04-address-picked")
    }

    @Test fun oldServerHidesSearchAndDuplicateSheetSavesAcknowledged() {
        val backend = Backend(config(false), oldServer); val opened = mutableListOf<String>(); show(backend, opened)
        waitTag("census-gps"); assertTrue(rule.onAllNodesWithTag("census-search-mode").fetchSemanticsNodes().isEmpty())
        rule.onNodeWithTag("census-name").performTextInput("Aling Nena Sari-Sari Store")
        rule.onNodeWithTag("census-owner").performTextInput("Nena Cruz")
        rule.onNodeWithTag("census-phone").performTextInput("0917 123 4567")
        rule.onNodeWithTag("census-channel").performScrollTo().performClick(); rule.onNodeWithText("General trade").performClick()
        rule.onNodeWithTag("census-subchannel").performScrollTo().performClick(); rule.onNodeWithText("Sari-sari").performClick()
        rule.onNodeWithTag("census-gps").performScrollTo().performClick()
        waitTag("census-accuracy"); waitTag("census-location-note")
        rule.onNodeWithTag("census-address").performScrollTo().performTextInput("Colon St corner Sanciangko")
        shot("05-old-server-gps-only")
        rule.onNodeWithTag("census-camera").performScrollTo().performClick()
        waitTag("census-shutter", 15_000); Thread.sleep(3000)
        rule.onNodeWithTag("census-shutter").performScrollTo().performClick()
        // Emulators without a working camera cannot produce the storefront photo; the Xiaomi run covers it.
        org.junit.Assume.assumeTrue("storefront camera produced no photo on this device",
            runCatching { waitTag("census-camera", 45_000) }.isSuccess)
        rule.onNodeWithTag("census-save").performClick()
        waitTag("census-duplicates"); shot("06-duplicate-sheet")
        rule.onNodeWithTag("census-dup-different").performClick()
        rule.waitUntil(10_000) { backend.queued.isNotEmpty() }
        val p = backend.queued.single()
        assertEquals("gps", p.getString("locationSource")); assertFalse(p.has("batchId"))
        assertEquals("o1", p.getJSONArray("acknowledgedDuplicateIds").getString(0))
        shot("07-saved")
    }

    /** SP-0163 jc on the Xiaomi: the phone's navigation bar covered "Save store". Edge-to-edge like the app; the
     * whole button must sit above the navigation-bar inset. */
    @Test fun saveButtonIsFullyAboveTheNavigationBar() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        show(Backend(config(true), online)); waitTag("census-save")
        val nav = rule.runOnUiThread<Int> {
            val decor = rule.activity.window.decorView
            androidx.core.view.ViewCompat.getRootWindowInsets(decor)!!
                .getInsets(androidx.core.view.WindowInsetsCompat.Type.navigationBars()).bottom
        }
        val height = rule.runOnUiThread<Int> { rule.activity.window.decorView.height }
        val bounds = rule.onNodeWithTag("census-save").fetchSemanticsNode().boundsInWindow
        assertTrue("save bottom ${bounds.bottom} must be <= ${height - nav} (nav inset $nav)", bounds.bottom <= height - nav + 0.5f)
        assertTrue(bounds.top > 0f)
        shot("00-save-above-nav")
    }

    // ---- Live test 2026-11-09: missing fields and a stale location on Save ----
    private val jpeg = byteArrayOf(0xff.toByte(), 0xd8.toByte(), 1, 2, 0xff.toByte(), 0xd9.toByte())
    private fun at(lat: Double, ageMs: Long = 0) = JSONObject().put("latitude", lat).put("longitude", 123.8854).put("accuracyMeters", 12.0)
        .put("fixTime", System.currentTimeMillis() - ageMs).put("provider", "fused").put("mockSignal", false)
    /** First tap of Use my location gets a fix that is already 3 minutes old; Save's refresh waits on [gate]. */
    private class SequenceGps(val first: JSONObject, val gate: kotlinx.coroutines.CompletableDeferred<JSONObject?>) : VisitLocation {
        var calls = 0
        override val requiresPermission = false
        override suspend fun fix(): JSONObject? { calls++; return if (calls == 1) first else gate.await() }
    }
    private fun showWith(backend: Backend, location: VisitLocation) = rule.setContent {
        MaterialTheme(colorScheme = SunprideTokens.lightColors) {
            // Like the app shell: content starts below the status bar.
            androidx.compose.material3.Surface(androidx.compose.ui.Modifier.fillMaxSize().statusBarsPadding()) { CensusScreen(backend, location, {}, photoForTest = jpeg) }
        }
    }
    private fun hideKeyboard() {
        rule.runOnUiThread { val w = rule.activity.window
            androidx.core.view.WindowInsetsControllerCompat(w, w.decorView).hide(androidx.core.view.WindowInsetsCompat.Type.ime()) }
        rule.waitForIdle(); Thread.sleep(400)
    }
    private fun fillAll() {
        rule.onNodeWithTag("census-name").performTextInput("Bebot Grocery")
        rule.onNodeWithTag("census-owner").performTextInput("Bebot Reyes")
        rule.onNodeWithTag("census-phone").performTextInput("0917 765 4321")
        choose("census-channel", "General trade"); choose("census-subchannel", "Sari-sari")
    }
    private fun choose(tag: String, option: String) {
        rule.onNodeWithTag(tag).performScrollTo().performClick(); rule.waitForIdle()
        rule.waitUntil(5_000) { rule.onAllNodesWithText(option).fetchSemanticsNodes().isNotEmpty() }
        Thread.sleep(300) // let the menu popup finish opening before the tap
        rule.onNodeWithText(option).performClick(); rule.waitForIdle()
        rule.waitUntil(5_000) { rule.onAllNodesWithText(option).fetchSemanticsNodes().size == 1 && runCatching { rule.onNodeWithTag(tag).assertTextContains(option, substring = true) }.isSuccess }
    }

    @Test fun saveWithMissingFieldsMarksEachOneAndScrollsToTheFirst() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val backend = Backend(config(true), online)
        val gate = kotlinx.coroutines.CompletableDeferred<JSONObject?>()
        showWith(backend, SequenceGps(at(10.3157), gate)); waitTag("census-gps")
        rule.onNodeWithTag("census-name").performTextInput("Bebot Grocery")
        rule.onNodeWithTag("census-phone").performTextInput("0917 765 4321")
        hideKeyboard()
        rule.onNodeWithTag("census-landmark").performScrollTo()  // the agent is scrolled down near Save
        rule.onNodeWithTag("census-save").performClick(); rule.waitForIdle()
        for (f in listOf("owner", "channel", "subchannel", "location", "address")) waitTag("census-missing-$f", 3_000)
        assertTrue(rule.onAllNodesWithTag("census-missing-name").fetchSemanticsNodes().isEmpty())
        assertTrue(rule.onAllNodesWithTag("census-missing-photo").fetchSemanticsNodes().isEmpty())
        rule.onNodeWithTag("census-missing-channel").assertTextContains("Choose a channel")
        rule.onNodeWithTag("census-save-note").assertTextContains("Fill in the 5 fields marked above")
        // Scrolled to the first missing field (owner) and it is on screen.
        rule.onNodeWithTag("census-missing-owner").assertIsDisplayed()
        shot("ux-missing-fields")
        assertTrue(backend.queued.isEmpty())
        // Filling a field clears its mark; the count follows.
        rule.onNodeWithTag("census-owner").performTextInput("Bebot Reyes")
        rule.waitUntil(3_000) { rule.onAllNodesWithTag("census-missing-owner").fetchSemanticsNodes().isEmpty() }
        rule.onNodeWithTag("census-save-note").assertTextContains("Fill in the 4 fields marked above")
    }

    @Test fun staleFixIsRefreshedOnSaveAndKeepsTheConfirmedAddress() {
        rule.runOnUiThread { rule.activity.enableEdgeToEdge() }
        val backend = Backend(config(false), oldServer)
        val gate = kotlinx.coroutines.CompletableDeferred<JSONObject?>()
        val gps = SequenceGps(at(10.3157, ageMs = 180_000), gate)
        showWith(backend, gps); waitTag("census-gps")
        fillAll()
        rule.onNodeWithTag("census-gps").performScrollTo().performClick(); waitTag("census-accuracy")
        rule.onNodeWithTag("census-address").performScrollTo().performTextInput("Purok 3, Barangay Tres")
        hideKeyboard()
        rule.onNodeWithTag("census-save").performClick()
        rule.waitUntil(5_000) { rule.onAllNodesWithText("Checking your location…").fetchSemanticsNodes().isNotEmpty() }
        assertEquals(2, gps.calls)
        shot("ux-checking-location")
        gate.complete(at(10.3159)) // ~22 m away: keep the address the agent confirmed
        rule.waitUntil(10_000) { backend.queued.isNotEmpty() }
        val p = backend.queued.single()
        assertEquals("gps", p.getString("locationSource")); assertEquals("Purok 3, Barangay Tres", p.getString("address"))
        assertEquals(10.3159, p.getJSONObject("location").getDouble("latitude"), 1e-9)
        assertTrue(kotlin.math.abs(System.currentTimeMillis() - p.getJSONObject("location").getLong("fixTime")) < 60_000)
    }

    @Test fun staleFixThatMovedFarAsksToConfirmTheNewAddress() {
        val backend = Backend(config(true), online)
        val gate = kotlinx.coroutines.CompletableDeferred<JSONObject?>(at(10.3166)) // ~100 m away
        showWith(backend, SequenceGps(at(10.3157, ageMs = 180_000), gate)); waitTag("census-gps")
        fillAll()
        rule.onNodeWithTag("census-gps").performScrollTo().performClick(); waitTag("census-accuracy")
        rule.waitUntil(5_000) { rule.onAllNodesWithTag("census-address-line").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("census-save").performClick()
        waitTag("census-moved"); rule.onNodeWithTag("census-moved-address").assertTextContains("12 Colon St, Cebu City")
        assertTrue(backend.queued.isEmpty())
        shot("ux-location-moved")
        rule.onNodeWithTag("census-moved-new").performClick()
        rule.waitUntil(10_000) { backend.queued.isNotEmpty() }
        assertEquals(10.3166, backend.queued.single().getJSONObject("location").getDouble("latitude"), 1e-9)
    }

    @Test fun staleFixThatCannotBeRefreshedShowsThePlainMessageAndRetry() {
        val backend = Backend(config(false), oldServer)
        val gate = kotlinx.coroutines.CompletableDeferred<JSONObject?>().apply { complete(null) } // no fix
        showWith(backend, SequenceGps(at(10.3157, ageMs = 180_000), gate)); waitTag("census-gps")
        fillAll()
        rule.onNodeWithTag("census-gps").performScrollTo().performClick(); waitTag("census-accuracy")
        rule.onNodeWithTag("census-address").performScrollTo().performTextInput("Purok 3")
        rule.onNodeWithTag("census-save").performClick()
        waitTag("census-retry")
        rule.onNodeWithTag("census-save-note").assertTextContains("Get a fresh GPS fix", substring = true)
        rule.onNodeWithText("Save store").assertExists()
        assertTrue(backend.queued.isEmpty())
    }
}
