package com.sunpride.field.callflow

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.*
import com.sunpride.field.auth.SessionVaults
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.*
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** F-006 F-106 F-107 F-120 F-204 F-207. Explicitly opt-in real API/SQLCipher/Keystore/UI proof.
 * Only the GPS boundary is a marked sample coordinate, not a real-route or OS integrity certification.
 * Credentials arrive in a private file through adb stdin, never instrumentation arguments or logs. */
class CallFlowLiveDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private fun waitTag(tag: String) = rule.waitUntil(60_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun shot(name: String) {
        rule.waitForIdle()
        val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        File(rule.activity.getExternalFilesDir(null),"callflow-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }
        bitmap.recycle()
    }
    @Test fun F006_F106_F107_F120_F204_F207_liveConfiguredFieldCall() {
        val context = rule.activity.applicationContext
        val file = File(context.filesDir,"callflow-proof.json")
        assumeTrue("Opt-in lane API proof file is not present",file.exists())
        val config = JSONObject(file.readText()); file.delete()
        val environment = AppEnvironment(config.getString("origin"))
        check(environment.apiOrigin == "http://127.0.0.1:4440" && BuildConfig.DEBUG)
        val backend = LiveFieldBackend(environment,SessionVaults.app(context),context) { KeystoreDeviceKey.loadOrCreate(context) }
        runCatching { backend.signOut() }
        var outside = true
        val location = object : VisitLocation {
            override val requiresPermission = false
            override suspend fun fix() = JSONObject().put("latitude",config.getDouble("latitude") + if (outside) 0.1 else 0.0)
                .put("longitude",config.getDouble("longitude")).put("accuracyMeters",5).put("fixTime",System.currentTimeMillis())
                .put("provider","gps").put("mockSignal",false)
        }
        rule.setContent { FieldApp(environment,false,backend=backend,features=FieldFeatures.ALL,visitLocation=location) }
        waitTag("email")
        rule.onNodeWithTag("email").performTextInput(config.getString("email"))
        rule.onNodeWithTag("password").performTextInput(config.getString("password"))
        rule.onNodeWithTag("sign-in").performClick()
        rule.waitUntil(60_000) { rule.onAllNodesWithText(config.getString("outletName")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText(config.getString("outletName")).performScrollTo().performClick()
        waitTag("diagnostic-title")
        rule.onNodeWithTag("sequence-reason").performScrollTo().performTextInput("Buyer appointment before the earlier stop")
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(60_000) { rule.onAllNodesWithTag("queue-error").fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("queue-error").performScrollTo().assertTextContains("Outside")
        shot("field-outside-refused")
        outside = false
        rule.onNodeWithTag("diagnostic-checkin").performClick()
        rule.waitUntil(60_000) { rule.onAllNodesWithTag("diagnostic-checkout").fetchSemanticsNodes().isNotEmpty() }
        shot("field-definition-started")
        rule.onNodeWithTag("short-call-reason").performScrollTo().performTextInput("Sample proof call with the buyer unavailable")
        rule.onNodeWithTag("diagnostic-outcome").performScrollTo().performClick()
        rule.onNodeWithTag("zero-sale-no_demand").performScrollTo().performClick()
        rule.onNodeWithTag("diagnostic-checkout").performClick()
        waitTag("diagnostic-confirm-end")
        rule.onNodeWithTag("diagnostic-confirm-end").performClick()
        waitTag("visit-result")
        rule.onNodeWithTag("visit-result").performScrollTo()
        shot("field-zero-sale-closed")
        // Use the same production transport to drain the exact queued bytes and retain the signed-in phone.
        val signer = backend.loadSigner()
        val device = checkNotNull(backend.cachedDeviceId)
        backend.today(device,signer,true)
        val rows = backend.visitStates().filter { it.first.clientVisitId == backend.visitStates().last().first.clientVisitId }
        check(rows.any { it.first.kind == "visit.checkOut" && it.second == "done" })
    }
}
