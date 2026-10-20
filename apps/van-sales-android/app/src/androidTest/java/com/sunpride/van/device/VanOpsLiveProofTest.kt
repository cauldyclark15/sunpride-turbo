package com.sunpride.van.device

import android.net.ConnectivityManager
import android.provider.Settings
import android.view.accessibility.AccessibilityNodeInfo
import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.BuildConfig
import com.sunpride.van.MainActivity
import com.sunpride.van.data.*
import com.sunpride.van.evidence.*
import com.sunpride.van.pos.*
import com.sunpride.van.storage.*
import com.sunpride.van.ui.CustomerSignature
import com.sunpride.van.ui.SunprideTokens
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import java.io.File
import java.util.UUID

/** Opt-in F-123 H10P live-backend proof. Ordinary suites skip this; it never uses a fake gateway.
 * Host holds the POS lock and stages prepare → BOTH radios + adb reverse off → capture → reconnect → sync.
 * Password comes from an app-private staged file and is removed before offline capture. No tokens are exported.
 */
class VanOpsLiveProofTest {
    @get:Rule val compose=createEmptyComposeRule()
    private val instrumentation=InstrumentationRegistry.getInstrumentation()
    private val context=instrumentation.targetContext
    private val directory get()=File(context.filesDir,"vanops-live-proof").apply {mkdirs()}
    private fun result(phase: String,data: JSONObject) {File(directory,"$phase.json").writeText(data.toString())}
    private fun screenshot(name: String) {
        val shot=checkNotNull(instrumentation.uiAutomation.takeScreenshot()) {"Screenshot unavailable"}
        File(directory,"$name.png").outputStream().use {check(shot.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it))}
        shot.recycle()
    }
    private fun cameraPermission() {
        fun click(node: AccessibilityNodeInfo?): Boolean {
            if(node==null)return false
            val label=node.text?.toString()?.lowercase().orEmpty()
            if(label in setOf("while using the app","only this time","allow")) return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            for(i in 0 until node.childCount) if(click(node.getChild(i)))return true
            return false
        }
        click(instrumentation.uiAutomation.rootInActiveWindow)
    }
    @Composable private fun Theme(content: @Composable ()->Unit) {
        MaterialTheme(colorScheme=SunprideTokens.lightColors,typography=SunprideTokens.typography,shapes=SunprideTokens.shapes,content=content)
    }
    @Test fun F123_realH10pOfflineRouteAndLiveSignedReplay()=runBlocking {
        val phase=InstrumentationRegistry.getArguments().getString("vanOpsProof")
        assumeTrue(phase in setOf("prepare","capture","sync","verify"))
        assertEquals("H10P lane origin must be explicit", "http://127.0.0.1:4470",BuildConfig.API_ORIGIN)
        val file=File(context.filesDir,"vanops-live-proof-private.json")
        val config=JSONObject(file.readText())
        val repository=VanRepository.create(context)
        var scenario: ActivityScenario<MainActivity>?=null
        var db: VanDatabase?=null
        try {
            if(phase=="prepare") {
                repository.signIn(config.getString("email"),config.getString("password"));repository.syncNow()
                assertEquals(config.getString("tripId"),repository.currentTrip.first()!!.tripId)
                assertEquals(1,repository.policy.first()!!.operationsVersion)
                assertTrue(repository.products.first().any {it.productId==config.getString("productId")})
                assertTrue(repository.customers.first().any {it.outletId==config.getString("outletId")})
                config.remove("password");config.remove("email");file.writeText(config.toString())
                result("prepare",JSONObject().put("verifiedBootstrap",true).put("tripId",config.getString("tripId")))
            } else {
                if(phase=="capture") {
                    assertEquals(0,Settings.Global.getInt(context.contentResolver,"wifi_on",-1))
                    assertEquals(0,Settings.Global.getInt(context.contentResolver,"mobile_data",-1))
                    val network=context.getSystemService(ConnectivityManager::class.java)
                    assertNull("No validated network during the trip",network.activeNetwork)
                    val reachable=withContext(Dispatchers.IO) {runCatching {val c=java.net.URL(BuildConfig.API_ORIGIN+"/healthz").openConnection().apply {connectTimeout=1500;readTimeout=1500};c.getInputStream().use {it.read()}}.isSuccess}
                    assertFalse("USB reverse must be removed too; radio-off with a working loopback API is not offline",reachable)
                }
                repository.restoreSession()
                assertTrue(repository.sessionState.value.signedIn)
                val scope=checkNotNull(repository.storeScope.first())
                val database=EncryptedVanDatabase.open(context)
                db=database
                val store=RoomVanStore(database,scope)
                if(phase=="capture") {
                    repository.recordTemperature(-200,"load_out",null)
                    val load=checkNotNull(repository.load.first())
                    repository.confirmLoad(load.lines.map {LoadActual(it.lineNumber,it.expectedBase)})
                    repository.startTrip(true,true,odometerKm=1000.0)
                    val outlet=config.getString("outletId")
                    val product=config.getString("productId")
                    repository.recordStop(outlet,"arrival")
                    repository.recordTemperature(-200,"delivery",outlet)
                    val quantity=12L
                    val total=quantity*100L
                    val sale=repository.completeSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(product,quantity)),PaymentInput("cash",total)),total)
                    val operation=JSONObject(store.pending().single {it.kind=="sale.record"}.operationJson).getJSONObject("payload")
                    val allocations=operation.getJSONArray("lines").getJSONObject(0).getJSONArray("allocations")
                    assertEquals(config.getString("lotA"),allocations.getJSONObject(0).getString("lotId"));assertEquals("3",allocations.getJSONObject(0).getString("quantityBase"))
                    assertEquals(config.getString("lotB"),allocations.getJSONObject(1).getString("lotId"));assertEquals((quantity-3L).toString(),allocations.getJSONObject(1).getString("quantityBase"))
                    val photo=CompletableDeferred<DamageCapture>()
                    scenario=ActivityScenario.launch(MainActivity::class.java)
                    scenario.onActivity {a->a.setContent {Theme {DamageCameraScreen({photo.complete(it)},{photo.completeExceptionally(IllegalStateException("Camera cancelled"))})}}}
                    compose.waitUntil(30_000){cameraPermission();runCatching {compose.onNodeWithTag("damage-capture").assertIsEnabled()}.isSuccess}
                    screenshot("return-camera")
                    compose.onNodeWithTag("damage-capture").performClick()
                    val encoded=repository.prepareReturnPhoto(withTimeout(30_000){photo.await()})
                    val acknowledgement=CompletableDeferred<String>()
                    scenario.onActivity {a->a.setContent {Theme {CustomerSignature("SAMPLE Customer",{}, {if(it!=null) acknowledgement.complete(it)})}}}
                    compose.onNodeWithTag("return-signature").assertExists().performTouchInput {swipe(Offset(width*0.2f,height*0.7f),Offset(width*0.8f,height*0.25f),500)}
                    val signature=withTimeout(10_000){acknowledgement.await()}
                    screenshot("customer-signature")
                    repository.recordReturn(ReturnRequest(UUID.randomUUID().toString(),outlet,sale.saleId,listOf(ReturnLineInput(product,"PC",1,"damaged",ReturnDisposition.BAD_STOCK,allocations.getJSONObject(0).getString("batch"))),acknowledgementJson=signature,photoJson=encoded))
                    val items=repository.routeSnapshot()!!.getJSONObject("policies").getJSONObject("returnables").getJSONArray("items")
                    for(i in 0 until items.length()) {val code=items.getJSONObject(i).getString("code");repository.recordReturnable(null,code,"count",if(code=="crate")12 else 0)}
                    repository.recordReturnable(outlet,"crate","issue",2);repository.recordReturnable(outlet,"crate","receive",1)
                    repository.recordTemperature(-200,"interval",null)
                    repository.requestReload(product,12,"SAMPLE full-offline request; no stock is promised")
                    repository.recordStop(outlet,"departure")
                    repository.countCash(CashCountRequest(UUID.randomUUID().toString(),mapOf(100L to total/100L),null,null,null,total))
                    val stock=checkNotNull(repository.stockSummary())
                    val batch=repository.batchPositions().filter {it.status in setOf("available","damaged")}
                    repository.countStock(StockCountRequest(UUID.randomUUID().toString(),stock.lines.map {StockCountLine(it.productId,it.status,it.expectedBase,if(it.productId!=product)0L else if(it.status=="available")20L-quantity else 1L)},batchCounts=batch.map {b->BatchCountLine(b,when {b.status=="damaged"->1L;b.lotId==config.getString("lotA")->0L;else->17L-(quantity-3L)})}))
                    repository.recordUnload()
                    val summary=checkNotNull(repository.closeSummary())
                    repository.closeTrip(TripCloseRequest(UUID.randomUUID().toString(),summary.checklist.reviewCode,1020.0,null))
                    val rows=database.rows().outboxRows(scope.fullAuthSubject,scope.deviceId)
                    assertTrue(rows.isNotEmpty());assertTrue(rows.all {it.status=="pending"})
                    result("capture",JSONObject().put("wifiOff",true).put("mobileDataOff",true).put("apiUnreachable",true).put("realCamera",true).put("signatureCanvas",true).put("locallyCompleted",true).put("operationCount",rows.size).put("operations",JSONArray(rows.map {JSONObject().put("id",it.clientRequestId).put("kind",it.kind).put("sha256",hex(sha256(it.operationJson.toByteArray())))})))
                    scenario.recreate()
                    compose.waitUntil(30_000){runCatching {compose.onNodeWithTag("trip-status").assertTextContains("Closed on this phone")}.isSuccess}
                    screenshot("locally-completed-offline")
                    compose.onNodeWithTag("open-route-ops").performScrollTo().performClick();compose.waitForIdle();screenshot("offline-scorecard")
                } else {
                    val captured=JSONObject(File(directory,"capture.json").readText())
                    repository.syncNow()
                    assertTrue(database.rows().outboxRows(scope.fullAuthSubject,scope.deviceId).all {it.status=="done"})
                    val meta=database.rows().meta(scope.fullAuthSubject,scope.deviceId)!!
                    assertFalse(meta.held)
                    val operations=captured.getJSONArray("operations")
                    for(i in 0 until operations.length()) {val op=operations.getJSONObject(i);val row=checkNotNull(database.rows().outbox(scope.fullAuthSubject,scope.deviceId,op.getString("id")));assertEquals(op.getString("sha256"),hex(sha256(row.operationJson.toByteArray())));assertEquals("done",row.status);assertNotNull(database.rows().ack(scope.fullAuthSubject,scope.deviceId,row.clientRequestId))}
                    repository.syncNow();assertTrue(store.pending().isEmpty())
                    val route=repository.routeSnapshot()!!
                    result(phase!!,JSONObject().put("pending",store.pending().size).put("operationCount",operations.length()).put("immutableBytes",true).put("settlementState",route.optString("settlementState")))
                    scenario=ActivityScenario.launch(MainActivity::class.java)
                    compose.waitUntil(30_000){runCatching {compose.onNodeWithTag("open-route-ops").assertExists()}.isSuccess}
                    compose.onNodeWithTag("open-route-ops").performScrollTo().performClick();compose.waitForIdle();screenshot(if(phase=="sync")"pending-supervisor" else "office-signoff-state")
                }
            }
        } catch(error: Throwable) {runCatching {screenshot("failure-$phase")};throw error}
        finally {scenario?.close();db?.close();repository.close()}
        Unit
    }
}
