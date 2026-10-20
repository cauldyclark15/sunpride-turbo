package com.sunpride.van.callflow

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.espresso.Espresso
import com.sunpride.van.*
import com.sunpride.van.data.VanRepository
import com.sunpride.van.ui.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import java.io.File

/** F-006 F-106 F-107 F-120 F-204 F-207. Opt-in real API / native UI / SQLCipher proof.
 * The only substituted boundary is sample GPS coordinates. This is not the 12-hour real-route acceptance. */
class CallFlowLiveDeviceTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()
    private fun waitTag(tag: String) = rule.waitUntil(60_000) { rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty() }
    private fun hideKeyboard() { Espresso.closeSoftKeyboard(); rule.waitForIdle() }
    private fun shot(name: String) {
        rule.waitForIdle()
        val bitmap = checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        File(rule.activity.getExternalFilesDir(null),"callflow-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) }
        bitmap.recycle()
    }
    @Test fun F006_F106_F107_F120_F204_F207_liveConfiguredVanCall() {
        val context=rule.activity.applicationContext
        val file=File(context.filesDir,"callflow-proof.json")
        assumeTrue("Opt-in lane API proof file is not present",file.exists())
        val config=JSONObject(file.readText());file.delete()
        val environment=AppEnvironment(config.getString("origin"))
        check(environment.siteUrl == "http://127.0.0.1:4440" && BuildConfig.DEBUG)
        val repository=VanRepository.create(context,environment=environment)
        runBlocking { runCatching { repository.signOut() } }
        var outside=true
        val controller=VanController(repository,environment,callLocationSource={
            JSONObject().put("latitude",config.getDouble("latitude")+if(outside)0.1 else 0.0).put("longitude",config.getDouble("longitude"))
                .put("accuracyMeters",5).put("fixTime",System.currentTimeMillis()).put("provider","gps").put("mockSignal",false)
        })
        rule.setContent { VanApp(controller,restore=false) }
        waitTag("email")
        rule.onNodeWithTag("email").performTextInput(config.getString("email"))
        rule.onNodeWithTag("password").performTextInput(config.getString("password"))
        hideKeyboard()
        rule.onNodeWithTag("sign-in").performClick()
        waitTag("open-customers")
        rule.onNodeWithTag("open-customers").performScrollTo().performClick()
        rule.waitUntil(60_000) { rule.onAllNodesWithText(config.getString("outletName"),substring=true).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText(config.getString("outletName"),substring=true).performScrollTo().performClick()
        waitTag("callflow-state")
        rule.waitUntil(60_000) { !controller.busy }
        rule.onNodeWithTag("callflow-sequence").performScrollTo().performTextInput("Buyer appointment before the earlier stop")
        hideKeyboard()
        rule.onNodeWithTag("callflow-start").performScrollTo().assertIsEnabled().performClick()
        rule.waitUntil(60_000) { !controller.busy && controller.message != null }
        if(controller.message?.startsWith("Outside") != true) {
            val failure=runCatching { runBlocking { repository.recordCall("call.start",config.getString("outletId"),
                JSONObject().put("latitude",config.getDouble("latitude")+0.1).put("longitude",config.getDouble("longitude"))
                    .put("accuracyMeters",5).put("fixTime",System.currentTimeMillis()).put("provider","gps").put("mockSignal",false),
                JSONObject().put("sequenceReason","Buyer appointment before the earlier stop")) } }.exceptionOrNull()
            throw AssertionError("Call refusal was not the radius guard: ${controller.message}; direct boundary: ${failure?.javaClass?.simpleName}: ${failure?.message}",failure)
        }
        rule.onNodeWithTag("message").performScrollTo().assertTextEquals("Outside the store radius. Move closer or request supervisor approval before starting.")
        shot("van-outside-refused")
        outside=false
        rule.onNodeWithTag("callflow-sequence").performScrollTo().performTextClearance()
        hideKeyboard()
        rule.onNodeWithTag("callflow-start").performScrollTo().performClick()
        rule.waitUntil(60_000) { controller.message?.contains("sequence deviation reason") == true }
        rule.onNodeWithTag("message").performScrollTo().assertTextEquals("An earlier planned store is still open. Give a sequence deviation reason.")
        shot("van-sequence-required")
        rule.onNodeWithTag("callflow-sequence").performScrollTo().performTextInput("Buyer appointment before the earlier stop")
        hideKeyboard()
        rule.onNodeWithTag("callflow-start").performScrollTo().performClick()
        rule.waitUntil(60_000) { controller.currentCall != null && !controller.busy }
        rule.onNodeWithTag("callflow-state").performScrollTo().assertTextEquals("Call in progress")
        shot("van-definition-started")
        rule.onNodeWithTag("callflow-stock-observation").performScrollTo().performTextInput("Sample shelf stock checked")
        hideKeyboard()
        rule.onNodeWithTag("callflow-stock").performScrollTo().performClick()
        rule.waitUntil(60_000) { !controller.busy }
        rule.onNodeWithTag("callflow-short").performScrollTo().performTextInput("Sample proof call with buyer unavailable")
        hideKeyboard()
        rule.onNodeWithTag("callflow-close").performScrollTo().performClick()
        rule.waitUntil(60_000) { controller.message?.contains("no-order reason") == true }
        rule.onNodeWithTag("message").performScrollTo().assertTextEquals("Choose a no-order reason from the list.")
        shot("van-zero-sale-required")
        rule.onNodeWithTag("callflow-zero-no_demand").performScrollTo().performClick()
        rule.onNodeWithTag("callflow-close").performScrollTo().performClick()
        rule.waitUntil(60_000) { controller.currentCall == null && !controller.busy }
        rule.onNodeWithTag("message").performScrollTo().assertTextEquals("Call saved on this phone. Sync sends it to the office.")
        shot("van-zero-sale-closed")
        runBlocking {
            repository.syncNow()
            val status=repository.syncStatus.first()
            check(status.queued==0 && status.sending==0 && status.review==0 && status.held==0 && status.received>=3)
            repository.syncNow()
            check(repository.syncStatus.first().received==status.received)
        }
        repository.close()
    }
}
