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
        catch(e:Throwable) {runCatching {if(rule.onAllNodesWithTag("email").fetchSemanticsNodes().isEmpty()) shot("field-failed-$tag")};throw e}
    }
    private fun transportGate(name:String) {
        val context=rule.activity.applicationContext
        File(context.filesDir,"presell-$name-ready").writeText("ready")
        val ready=File(context.filesDir,"presell-$name")
        kotlinx.coroutines.runBlocking {kotlinx.coroutines.withTimeout(60_000){while(!ready.exists()) kotlinx.coroutines.delay(100)}}
        ready.delete();File(context.filesDir,"presell-$name-ready").delete()
    }
    private fun hideKeyboard() { androidx.test.espresso.Espresso.closeSoftKeyboard();rule.waitForIdle() }
    private fun shot(name:String) {
        hideKeyboard()
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
        rule.onNodeWithTag("password").performTextInput(fixture.getString("password"));hideKeyboard();rule.onNodeWithTag("sign-in").performClick()
        waitTag("customers-open");rule.onNodeWithTag("customers-open").performScrollTo().performClick()
        waitTag("customer-search");rule.onNodeWithTag("customer-search").performTextInput(fixture.getString("outletName"));hideKeyboard()
        waitTag("customer-result");rule.onNodeWithTag("customer-result").assertTextContains(fixture.getString("outletName"),substring=true).performClick()
        waitTag("customer-header");rule.onNodeWithTag("customer-header").assertTextContains(fixture.getString("outletName"),substring=true)
        waitTag("customer-visit")
        transportGate("offline")
        check(runCatching {java.net.Socket().use {it.connect(java.net.InetSocketAddress("127.0.0.1",4560),2000)}}.isFailure)
        rule.onNodeWithTag("customer-visit").performScrollTo().performClick();waitTag("diagnostic-title")
        if(rule.onAllNodesWithTag("unplanned-reason").fetchSemanticsNodes().isNotEmpty()) rule.onNodeWithTag("unplanned-reason").performScrollTo().performTextInput("Sample pre-sell buyer appointment outside the plan")
        if(rule.onAllNodesWithTag("sequence-reason").fetchSemanticsNodes().isNotEmpty()) rule.onNodeWithTag("sequence-reason").performScrollTo().performTextInput("Buyer appointment first")
        if(rule.onAllNodesWithTag("intent-sell").fetchSemanticsNodes().isNotEmpty() && runCatching {rule.onNodeWithTag("intent-sell").assertIsSelected()}.isFailure) rule.onNodeWithTag("intent-sell").performScrollTo().performClick()
        hideKeyboard()
        rule.onNodeWithTag("diagnostic-checkin").performClick();waitTag("diagnostic-checkout")
        check(backend.visitStates().any {it.first.kind=="visit.checkIn"&&JSONObject(it.first.serializedOperation).getJSONObject("payload").optString("outletId")==fixture.getString("outletId")}) {"Selected outlet differs from persisted check-in"}
        rule.onNodeWithTag("order-new").performScrollTo().performClick();waitTag("order-title")
        if(fixture.has("productCode")&&!fixture.isNull("productCode")) rule.onNodeWithTag("order-search").performScrollTo().performTextInput(fixture.getString("productCode"))
        rule.onNodeWithTag("order-qty-${fixture.getString("productId")}").performScrollTo().performTextInput("2")
        rule.onNodeWithTag("order-delivery-date").performScrollTo().performTextInput(fixture.getString("requestedDeliveryDate"))
        hideKeyboard()
        rule.onNodeWithTag("order-save").performClick();waitTag("order-review")
        rule.onNodeWithTag("order-review").performClick();waitTag("order-requested-delivery")
        rule.onNodeWithTag("order-requested-delivery").performScrollTo().assertTextEquals("Requested delivery · ${fixture.getString("requestedDeliveryDate")}\nOffice confirmation pending")
        shot("field-requested-date")
        rule.onNodeWithTag("order-submit").performClick()
        rule.waitUntil(60_000){backend.orderDrafts().any{it.requestedDeliveryDate==fixture.getString("requestedDeliveryDate")&&it.submittedRequestId!=null}}
        shot("field-order-queued")
        val id=backend.orderDrafts().last{it.requestedDeliveryDate==fixture.getString("requestedDeliveryDate")}.draftId
        check(backend.orderDrafts().single{it.draftId==id}.submittedRequestId!=null)
        File(rule.activity.getExternalFilesDir(null),"presell-field-result.json").writeText(JSONObject().put("clientOrderId",id).put("requestedDeliveryDate",fixture.getString("requestedDeliveryDate")).toString())
        transportGate("online")
        backend.today(checkNotNull(backend.cachedDeviceId),backend.loadSigner(),true)
        val request=checkNotNull(backend.orderDrafts().single {it.draftId==id}.submittedRequestId)
        val received=backend.visitStates().single {it.first.requestId==request}
        check(received.second=="done") { "Submitted pre-sell activity did not receive its durable acknowledgement" }
        val before=backend.visitStates().map {it.first.requestId to it.second}
        backend.today(checkNotNull(backend.cachedDeviceId),backend.loadSigner(),true)
        check(backend.visitStates().map {it.first.requestId to it.second}==before)
    }
}
