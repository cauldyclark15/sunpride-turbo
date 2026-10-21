package com.sunpride.van.storepos

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.AppEnvironment
import com.sunpride.van.BuildConfig
import com.sunpride.van.data.VanRepository
import com.sunpride.van.ui.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import java.io.File

/** F-R01: opt-in typed-password proof against the isolated retail lane API.
 * The host disables Wi-Fi/mobile and removes adb reverse for the offline phase.
 * Never selected in release, and never run against the public sample company. */
class StorePosLiveProofTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private fun file(name:String)=File(InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null),name)
    @Test fun F_R01_liveConfigurationAndOfflineCashierSession() {
        val phase=InstrumentationRegistry.getArguments().getString("storePosProof")
        assumeTrue(phase in setOf("signin","download","offline","sync","van"))
        check(BuildConfig.API_ORIGIN=="http://127.0.0.1:4590") {"Retail proof requires its isolated lane API"}
        val repository=VanRepository.forWorker(InstrumentationRegistry.getInstrumentation().targetContext,false)
        val controller=VanController(repository,AppEnvironment(BuildConfig.API_ORIGIN))
        val mounted=androidx.compose.runtime.mutableStateOf(true)
        try {
            rule.setContent {if(mounted.value)VanApp(controller,restore=phase!="signin")}
            if(phase=="signin") {
                val login=JSONObject(file("retail-phone-login.json").readText())
                rule.waitUntil(20_000){rule.onAllNodesWithTag("email").fetchSemanticsNodes().isNotEmpty()}
                rule.onNodeWithTag("email").performTextInput(login.getString("email"))
                rule.onNodeWithTag("password").performTextInput(login.getString("password"))
                file("retail-phone-login.json").delete()
                Espresso.closeSoftKeyboard()
                rule.onNodeWithTag("sign-in").performClick()
            }
            rule.waitUntil(20_000){controller.initialized && !controller.busy && controller.session.signedIn}
            if(phase=="signin") {
                val scope=runBlocking{checkNotNull(repository.storeScope.first())}
                file("retail-phone-stage.json").writeText(JSONObject().put("deviceId",scope.deviceId).toString())
                captureVanScreenshot(rule,"retail-live-signed-in")
            } else if(phase=="van") {
                rule.waitUntil(20_000){!controller.storeMode}
                rule.onNodeWithTag("store-shift").assertDoesNotExist()
                captureVanScreenshot(rule,"retail-live-back-to-van","home-primary")
            } else {
                rule.waitUntil(20_000){controller.storeMode}
                if(phase=="offline") {
                    rule.onNodeWithTag("store-shift").performClick()
                    rule.onNodeWithTag("store-cash-amount").performTextInput("1000")
                    Espresso.closeSoftKeyboard();rule.onNodeWithTag("save-store-shift").performClick()
                    rule.waitUntil(20_000){!controller.busy && controller.storePos.shift!=null}
                    captureVanScreenshot(rule,"retail-live-offline-open","save-store-shift")
                    rule.onNodeWithTag("store-cash-amount").performTextReplacement("800")
                    Espresso.closeSoftKeyboard()
                    captureVanScreenshot(rule,"retail-live-offline-blind","save-store-shift")
                    rule.onNodeWithTag("save-store-shift").performClick()
                    rule.waitUntil(20_000){!controller.busy && controller.storePos.shift==null}
                    assertEquals(2,controller.storePos.queued)
                    captureVanScreenshot(rule,"retail-live-offline-closed","store-shift")
                } else if(phase=="sync") {
                    rule.waitUntil(20_000){controller.storePos.queued==0}
                    assertEquals(0,controller.storePos.review)
                    captureVanScreenshot(rule,"retail-live-synced","store-shift")
                } else captureVanScreenshot(rule,"retail-live-store-mode","store-shift")
            }
        } finally {rule.runOnUiThread{mounted.value=false};rule.waitForIdle();repository.close()}
    }
}
