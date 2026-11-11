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
import androidx.compose.ui.test.performTextClearance
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
 * app's private files/cg-shots (pull with run-as). SP-0170: the new-customer form is covered by AddCustomerScreenTest;
 * this keeps the Edit customer (change request) and layout checks. */
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

    /** SP-0163 jc on the Xiaomi: the phone's navigation bar covered "Save customer". Edge-to-edge like the app; the
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
            androidx.compose.material3.Surface(androidx.compose.ui.Modifier.fillMaxSize().statusBarsPadding()) { CensusScreenForTest(backend, location, {}, photoForTest = jpeg) }
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

    @Test fun editStoreOpensTheFormFilledFromTheStore() {
        val backend = Backend(config(false), oldServer)
        val store = com.sunpride.field.ui.customers.CustomerRecord("o9", "Aling Nena Store", "OUT-9", address = "5 Rizal St",
            account = com.sunpride.field.storage.CallSheetHeader("Aling Nena Store", null, "Nena Cruz", "0917 555 0101", null, null,
                null, null, null, null))
        rule.setContent { MaterialTheme(colorScheme = SunprideTokens.lightColors) { CensusScreen(backend, gps, {}, editing = store) } }
        waitTag("census-edit-note")
        rule.onNodeWithTag("census-name").assertTextContains("Aling Nena Store")
        rule.onNodeWithTag("census-owner").performScrollTo().assertTextContains("Nena Cruz")
        rule.onNodeWithTag("census-phone").performScrollTo().assertTextContains("0917 555 0101")
        rule.onNodeWithTag("census-address").performScrollTo().assertTextContains("5 Rizal St")
        rule.onNodeWithTag("census-edit-note").assertTextContains("The office checks your changes first.")
    }

    private val target = UUID.randomUUID().toString()
    private fun editStore() = com.sunpride.field.ui.customers.CustomerRecord(target, "Aling Nena Store", "OUT-9", address = "5 Rizal St",
        account = com.sunpride.field.storage.CallSheetHeader("Aling Nena Store", null, "Nena Cruz", "0917 555 0101", null, null,
            null, null, null, null))

    // Save on Edit store sends a change request for THIS store (kind change + target), never a new store.
    @Test fun editStoreSaveSendsAChangeForTheStoreNotANewStore() {
        val backend = Backend(config(false), oldServer); var saved = 0
        rule.setContent { MaterialTheme(colorScheme = SunprideTokens.lightColors) {
            CensusScreen(backend, gps, {}, editing = editStore(), onChangeSaved = { saved++ }) } }
        waitTag("census-edit-note")
        // Edit store asks only for what a change needs: no channel, class or batch pickers.
        assertTrue(rule.onAllNodesWithTag("census-channel").fetchSemanticsNodes().isEmpty())
        assertTrue(rule.onAllNodesWithTag("census-batch").fetchSemanticsNodes().isEmpty())
        rule.onNodeWithTag("census-save").assertTextContains("Save changes")
        rule.onNodeWithTag("census-name").performTextClearance()
        rule.onNodeWithTag("census-name").performTextInput("Nena Mini Mart")
        shot("edit-01-changed-name")
        rule.onNodeWithTag("census-save").performClick()
        rule.waitUntil(10_000) { backend.queued.isNotEmpty() }
        val p = backend.queued.single()
        assertEquals("change", p.getString("kind"))
        assertEquals(target, p.getString("targetOutletId"))
        assertEquals("Nena Mini Mart", p.getString("name"))
        assertEquals("Nena Cruz", p.getString("ownerName"))
        assertFalse(p.has("channelId")); assertFalse(p.has("location")); assertFalse(p.has("photoJpegBase64"))
        rule.waitUntil(5_000) { saved == 1 }
    }

    @Test fun editStoreWithNothingChangedSendsNothing() {
        val backend = Backend(config(false), oldServer)
        rule.setContent { MaterialTheme(colorScheme = SunprideTokens.lightColors) { CensusScreen(backend, gps, {}, editing = editStore()) } }
        waitTag("census-edit-note")
        rule.onNodeWithTag("census-save").performClick()
        waitTag("census-save-note"); rule.onNodeWithTag("census-save-note").assertTextContains("Nothing was changed.")
        Thread.sleep(500); assertTrue(backend.queued.isEmpty())
    }
}
