package com.sunpride.van.delivery

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
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

/** F-303 F-304 opt-in H10P proof: real lane API, SQLCipher, signature UI and camera.
 * Only GPS uses explicit sample coordinates; not a physical-route/integrity attestation. */
class PresellLiveDeviceTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private fun waitTag(tag:String) {
        try { rule.waitUntil(60_000){rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()} }
        catch (e:Throwable) { runCatching {shot("van-failed-$tag")};throw e }
    }
    private fun hideKeyboard() { androidx.test.espresso.Espresso.closeSoftKeyboard();rule.waitForIdle() }
    private fun shot(name:String) {
        hideKeyboard()
        rule.waitForIdle()
        val bitmap=checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        File(rule.activity.getExternalFilesDir(null),"presell-$name.png").outputStream().use {bitmap.compress(Bitmap.CompressFormat.PNG,100,it)}
        bitmap.recycle()
    }
    private fun transportGate(name:String) {
        val context=rule.activity.applicationContext
        File(context.filesDir,"presell-$name-ready").writeText("ready")
        val ready=File(context.filesDir,"presell-$name")
        runBlocking { kotlinx.coroutines.withTimeout(60_000) { while(!ready.exists()) kotlinx.coroutines.delay(100) } }
        ready.delete();File(context.filesDir,"presell-$name-ready").delete()
    }
    @Test fun F303_F304_liveDeliverySignaturePhotoGeoOfflineThenSync() {
        val context=rule.activity.applicationContext
        val file=File(context.filesDir,"presell-proof.json")
        assumeTrue("Opt-in PRESELL lane proof file absent",file.exists())
        val fixture=JSONObject(file.readText());file.delete()
        InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName,android.Manifest.permission.CAMERA)
        val environment=AppEnvironment(fixture.getString("origin"))
        check(environment.siteUrl=="http://127.0.0.1:4560"&&BuildConfig.DEBUG)
        val repository=VanRepository.create(context,environment=environment)
        runBlocking {runCatching{repository.signOut()}}
        val controller=VanController(repository,environment,callLocationSource={JSONObject().put("latitude",fixture.getDouble("latitude")).put("longitude",fixture.getDouble("longitude")).put("accuracyMeters",5).put("fixTime",System.currentTimeMillis()).put("provider","gps").put("mockSignal",false)})
        rule.setContent {VanApp(controller,restore=false)}
        waitTag("email");rule.onNodeWithTag("email").performTextInput(fixture.getString("email"))
        rule.onNodeWithTag("password").performTextInput(fixture.getString("password"));hideKeyboard();rule.onNodeWithTag("sign-in").performClick()
        rule.waitUntil(60_000){controller.session.signedIn&&!controller.busy}
        shot("van-signed-in")
        waitTag("open-customers");rule.onNodeWithTag("open-customers").performScrollTo().performClick()
        waitTag("customer-search");rule.onNodeWithTag("customer-search").performTextInput(fixture.getString("outletName"));hideKeyboard()
        val customerMatch=hasText(fixture.getString("outletName"),substring=true) and !hasTestTag("customer-search")
        rule.waitUntil(60_000){rule.onAllNodes(customerMatch).fetchSemanticsNodes().isNotEmpty()}
        rule.onNode(customerMatch).performScrollTo().performClick()
        check(controller.selectedCustomer?.outletId==fixture.getString("outletId"))
        waitTag("callflow-state")
        val resumed=controller.currentCall!=null
        if(!resumed) {
            rule.onNodeWithTag("callflow-sequence").performScrollTo().performTextInput("Assigned delivery appointment first")
            if(rule.onAllNodesWithTag("callflow-unplanned").fetchSemanticsNodes().isNotEmpty()) rule.onNodeWithTag("callflow-unplanned").performScrollTo().performTextInput("Assigned pre-sell delivery")
            hideKeyboard()
            rule.onNodeWithTag("callflow-start").performScrollTo().assertIsEnabled().performClick()
            rule.waitUntil(60_000){controller.currentCall!=null&&!controller.busy}
        }
        check(controller.currentCall?.getString("outletId")==fixture.getString("outletId"))
        transportGate("offline")
        runBlocking { check(runCatching {repository.syncNow()}.isFailure) { "API must be unreachable while recording ePOD" } }
        rule.waitUntil(60_000){rule.onAllNodesWithTag("delivery-receiver").fetchSemanticsNodes().isNotEmpty() || rule.onAllNodesWithTag("delivery-saved").fetchSemanticsNodes().isNotEmpty()}
        val retainedProof=rule.onAllNodesWithTag("delivery-saved").fetchSemanticsNodes().isNotEmpty()
        if(!retainedProof) {
            val drop=runBlocking {repository.deliveryDrops().single {it.getString("outletId")==fixture.getString("outletId")}}
            if(drop.isNull("arrivedAt") || !drop.has("arrivedAt")) rule.onNodeWithTag("delivery-timing-arrival").performScrollTo().performClick()
            rule.waitUntil(60_000){runCatching{rule.onNodeWithTag("delivery-timing-unloading").assertIsEnabled()}.isSuccess}
            rule.onNodeWithTag("delivery-timing-unloading").performScrollTo().performClick()
            rule.onNodeWithTag("delivery-receiver").performScrollTo().performTextInput("Sample receiving buyer")
            rule.onNodeWithTag("delivery-accepted-0").performScrollTo().performTextReplacement((fixture.getInt("expectedBase")-1).toString())
            rule.onNodeWithTag("delivery-rejected-0").performScrollTo().performTextReplacement("1")
            rule.onNodeWithTag("delivery-reason-buyer_rejected").performScrollTo().performClick()
            hideKeyboard()
            rule.onNodeWithTag("delivery-signature").performScrollTo().performTouchInput {
                down(Offset(width*.1f,height*.6f));moveTo(Offset(width*.35f,height*.25f),120);moveTo(Offset(width*.6f,height*.7f),120);moveTo(Offset(width*.9f,height*.4f),120);up()
            }
            shot("van-signature")
            rule.onNodeWithTag("delivery-photo-save").performScrollTo().performClick()
            waitTag("damage-capture")
            rule.waitUntil(60_000){runCatching{rule.onNodeWithTag("damage-capture").assertIsEnabled()}.isSuccess}
            rule.onNodeWithTag("damage-capture").performClick()
        }
        waitTag("delivery-saved")
        val savedDrop=runBlocking {repository.deliveryDrops().single {it.getString("outletId")==fixture.getString("outletId")}}
        check(savedDrop.getString("status") in setOf("saved_on_phone","delivered","variance"))
        rule.onNodeWithTag("delivery-saved").performScrollTo().assertTextEquals(if(savedDrop.getString("status")=="saved_on_phone") "Proof saved on this phone. Sync sends the signature and photo." else "Delivery already confirmed.")
        if(savedDrop.isNull("departedAt") || !savedDrop.has("departedAt")) {
            rule.onNodeWithTag("delivery-timing-departure").performScrollTo().assertIsEnabled().performClick()
            rule.waitUntil(60_000){runCatching{rule.onNodeWithTag("delivery-timing-departure").assertIsNotEnabled()}.isSuccess}
        }
        File(rule.activity.getExternalFilesDir(null),"presell-van-native-summary.json").writeText(JSONObject().put("resumedOpenCall",resumed).put("retainedPriorProof",retainedProof).put("freshCameraCapture",!retainedProof).toString())
        shot("van-saved-offline")
        rule.onNodeWithTag("callflow-short").performScrollTo().performTextInput("Sample ePOD proof completed before the normal dwell time")
        hideKeyboard()
        rule.onNodeWithTag("callflow-close").performScrollTo().assertIsEnabled().performClick()
        rule.waitUntil(60_000){controller.currentCall==null&&!controller.busy}
        runBlocking { check(repository.syncStatus.first().queued>0) }
        transportGate("online")
        runBlocking {
            repository.syncNow(); val first=repository.syncStatus.first()
            check(first.queued==0&&first.sending==0&&first.review==0&&first.held==0)
            repository.syncNow();check(repository.syncStatus.first().received==first.received)
        }
        shot("van-synced")
        repository.close()
    }
}
