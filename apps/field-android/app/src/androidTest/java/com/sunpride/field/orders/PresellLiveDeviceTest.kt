package com.sunpride.field.orders

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

/** F-301 opt-in Redmi proof against the private lane API. GPS is explicit sample input, not physical presence. */
class PresellLiveDeviceTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private fun waitTag(tag:String) {
        try {rule.waitUntil(60_000){rule.onAllNodesWithTag(tag).fetchSemanticsNodes().isNotEmpty()}}
        catch(e:Throwable) {runCatching {shot("field-failed-$tag")};throw e}
    }
    private fun transportGate(name:String) {
        val context=rule.activity.applicationContext
        File(context.filesDir,"presell-$name-ready").writeText("ready")
        val ready=File(context.filesDir,"presell-$name")
        kotlinx.coroutines.runBlocking {kotlinx.coroutines.withTimeout(60_000){while(!ready.exists()) kotlinx.coroutines.delay(100)}}
        ready.delete();File(context.filesDir,"presell-$name-ready").delete()
    }
    private fun shot(name:String) {
        rule.waitForIdle();val bitmap=checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        File(rule.activity.getExternalFilesDir(null),"presell-$name.png").outputStream().use{bitmap.compress(Bitmap.CompressFormat.PNG,100,it)};bitmap.recycle()
    }
    @Test fun F301_liveRequestedDeliveryDaySurvivesDraftAndOfflineSubmission() {
        val context=rule.activity.applicationContext;val file=File(context.filesDir,"presell-proof.json")
        assumeTrue("Opt-in PRESELL lane proof file absent",file.exists())
        val fixture=JSONObject(file.readText());file.delete()
        val environment=AppEnvironment(fixture.getString("origin"));check(environment.apiOrigin=="http://127.0.0.1:4560"&&BuildConfig.DEBUG)
        val backend=LiveFieldBackend(environment,SessionVaults.app(context),context){KeystoreDeviceKey.loadOrCreate(context)}
        runCatching{backend.signOut()}
        val location=object:VisitLocation {
            override val requiresPermission=false
            override suspend fun fix()=JSONObject().put("latitude",fixture.getDouble("latitude")).put("longitude",fixture.getDouble("longitude")).put("accuracyMeters",5).put("fixTime",System.currentTimeMillis()).put("provider","gps").put("mockSignal",false)
        }
        rule.setContent{FieldApp(environment,false,backend=backend,features=FieldFeatures.ALL,visitLocation=location)}
        waitTag("email");rule.onNodeWithTag("email").performTextInput(fixture.getString("email"))
        rule.onNodeWithTag("password").performTextInput(fixture.getString("password"));rule.onNodeWithTag("sign-in").performClick()
        rule.waitUntil(60_000){rule.onAllNodesWithText(fixture.getString("outletName")).fetchSemanticsNodes().isNotEmpty()}
        transportGate("offline")
        check(runCatching {java.net.Socket().use {it.connect(java.net.InetSocketAddress("127.0.0.1",4560),2000)}}.isFailure)
        rule.onNodeWithText(fixture.getString("outletName")).performScrollTo().performClick();waitTag("diagnostic-title")
        if(rule.onAllNodesWithTag("sequence-reason").fetchSemanticsNodes().isNotEmpty()) rule.onNodeWithTag("sequence-reason").performScrollTo().performTextInput("Buyer appointment first")
        rule.onNodeWithTag("diagnostic-checkin").performClick();waitTag("diagnostic-checkout")
        rule.onNodeWithTag("order-new").performScrollTo().performClick();waitTag("order-title")
        rule.onNodeWithTag("order-qty-${fixture.getString("productId")}").performScrollTo().performTextInput("2")
        rule.onNodeWithTag("order-delivery-date").performScrollTo().performTextInput(fixture.getString("requestedDeliveryDate"))
        rule.onNodeWithTag("order-save").performClick();waitTag("order-review")
        shot("field-requested-date")
        rule.onNodeWithTag("order-review").performClick();waitTag("order-requested-delivery")
        rule.onNodeWithTag("order-requested-delivery").assertTextContains(fixture.getString("requestedDeliveryDate"))
        rule.onNodeWithTag("order-submit").performClick()
        rule.waitUntil(60_000){backend.orderDrafts().any{it.requestedDeliveryDate==fixture.getString("requestedDeliveryDate")&&it.submittedRequestId!=null}}
        shot("field-order-queued")
        val id=backend.orderDrafts().last{it.requestedDeliveryDate==fixture.getString("requestedDeliveryDate")}.draftId
        check(backend.orderDrafts().single{it.draftId==id}.submittedRequestId!=null)
        File(rule.activity.getExternalFilesDir(null),"presell-field-result.json").writeText(JSONObject().put("clientOrderId",id).put("requestedDeliveryDate",fixture.getString("requestedDeliveryDate")).toString())
        transportGate("online")
        backend.today(checkNotNull(backend.cachedDeviceId),backend.loadSigner(),true)
    }
}
