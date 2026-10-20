package com.sunpride.van.device

import android.graphics.Bitmap
import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.AppEnvironment
import com.sunpride.van.BuildConfig
import com.sunpride.van.data.*
import com.sunpride.van.pos.*
import com.sunpride.van.storage.*
import com.sunpride.van.printing.*
import com.sunpride.van.ui.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import java.io.File
import java.util.UUID

/** F-019/F-109/F-111 real H10P + lane API only. Default suite skips this explicit write proof.
 * Stage authenticates through the real typed-password UI; offline runs with every transport
 * removed by the host, and sync uses the unchanged production signer and API transport. */
class FiscalLiveProofTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private fun file(name:String)=File(context.getExternalFilesDir(null),name)
    private fun shot(name:String) {
        rule.waitForIdle()
        val bitmap=checkNotNull(InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot())
        file(name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG,100,it) };bitmap.recycle()
    }
    @Test fun F_019_F_109_F_111_realHandheldFiscalWalk() {
        val phase=InstrumentationRegistry.getArguments().getString("fiscalProof")
        assumeTrue(phase in listOf("stage","offline","sync"))
        when(phase) {
            "stage" -> {
                val login=JSONObject(file("fiscal-phone-login.json").readText())
                val repository=VanRepository.forWorker(context,false)
                val controller=VanController(repository,AppEnvironment(BuildConfig.API_ORIGIN))
                try {
                    rule.setContent { VanApp(controller,restore=false) }
                    rule.waitUntil(20_000){rule.onAllNodesWithTag("email").fetchSemanticsNodes().isNotEmpty()}
                    rule.onNodeWithTag("email").performTextInput(login.getString("email"))
                    rule.onNodeWithTag("password").performTextInput(login.getString("password"))
                    file("fiscal-phone-login.json").delete()
                    rule.onNodeWithTag("sign-in").assertIsDisplayed().performClick()
                    try { rule.waitUntil(20_000){controller.session.signedIn && !controller.busy && controller.trip != null && controller.load != null} }
                    catch(e:Throwable) { shot("fiscal-stage-failed.png"); throw AssertionError("Live stage: signedIn=${controller.session.signedIn}, busy=${controller.busy}, enrollment=${controller.enrollment::class.simpleName}, trip=${controller.trip!=null}, load=${controller.load!=null}; ${controller.message}",e) }
                    runBlocking {
                        val load=checkNotNull(controller.load)
                        if(load.status=="planned") { repository.confirmLoad(load.lines.map{LoadActual(it.lineNumber,it.expectedBase)});repository.syncNow() }
                        if(controller.trip?.status!="active") { repository.startTrip(true,true,odometerKm=100.0);repository.syncNow() }
                    }
                    val state=runBlocking {
                        val scope=checkNotNull(repository.storeScope.first())
                        val db=EncryptedVanDatabase.open(context)
                        try {
                            val store=RoomVanStore(db,scope);val cc=store.checkoutContext()
                            val productId=login.getString("productId")
                            val product=cc.products.single{it.productId==productId}
                            val option=cc.customers.mapNotNull { customer ->
                                val request=CheckoutRequest(UUID.randomUUID().toString(),customer.outletId,listOf(CartLine(productId,product.quantityScale)),PaymentInput("cash",CheckoutRules.MAX_MINOR))
                                CheckoutRules.evaluate(request,cc).quote?.let{Triple(customer,request,it)}
                            }.first()
                            val policy=JSONObject(db.rows().meta(scope.fullAuthSubject,scope.deviceId)!!.policyJson!!)
                            val range=com.sunpride.van.fiscal.FiscalNumbers.ranges(policy).single{it.getString("documentType")=="sales_invoice"}
                            JSONObject().put("subject",scope.fullAuthSubject).put("deviceId",scope.deviceId).put("tripId",db.rows().trip(scope.fullAuthSubject,scope.deviceId)!!.tripId)
                                .put("outletId",option.first.outletId).put("productId",productId).put("quantityBase",product.quantityScale.toString()).put("totalMinor",option.third.totalMinor.toString())
                                .put("nextNumber",range.getString("prefix")+"-"+range.getString("nextSerial").padStart(9,'0'))
                                .put("secondNumber",range.getString("prefix")+"-"+(range.getString("nextSerial").toLong()+1).toString().padStart(9,'0'))
                        } finally {db.close()}
                    }
                    file("fiscal-stage.json").writeText(state.toString());shot("fiscal-stage.png")
                } finally {repository.close()}
            }
            "offline" -> {
                val state=JSONObject(file("fiscal-stage.json").readText())
                val db=EncryptedVanDatabase.open(context)
                try {
                    val scope=StoreScope(state.getString("subject"),state.getString("deviceId"))
                    val store=RoomVanStore(db,scope)
                    val total=state.getString("totalMinor").toLong()
                    fun request(method:String,reference:String)=CheckoutRequest(UUID.randomUUID().toString(),state.getString("outletId"),listOf(CartLine(state.getString("productId"),state.getString("quantityBase").toLong())),PaymentInput(method,reference=reference))
                    val receipts=runBlocking {
                        val first=store.commitSale(request("maya","FISCAL-MAYA-"+UUID.randomUUID().toString().take(8)),total)
                        val second=store.commitSale(request("card","FISCAL-AUTH-"+UUID.randomUUID().toString().take(8)),total)
                        assertEquals(state.getString("nextNumber"),first.receiptNumber)
                        assertEquals(state.getString("secondNumber"),second.receiptNumber)
                        assertEquals("awaiting_confirmation",first.paymentStatus);assertEquals("awaiting_confirmation",second.paymentStatus)
                        val approval=JSONObject(file("fiscal-approval.json").readText())
                        store.voidSale(second.saleId,"customer_cancelled",null,approval.getString("code"))
                        file("fiscal-approval.json").delete()
                        RoomReceiptPrintLog(db,scope).savedSales()
                    }
                    val first=receipts.single{it.receipt.receiptNumber==state.getString("nextNumber")}
                    rule.setContent { MaterialTheme { FiscalPreviewButtons(first) } }
                    rule.onNodeWithTag("fiscal-preview").performClick();shot("fiscal-invoice.png")
                    rule.onNodeWithTag("close-fiscal-preview").performClick()
                    rule.onNodeWithTag("fiscal-reprint-preview").performClick();shot("fiscal-reprint.png")
                    val printer=SenraiseEmbeddedPrinter(context)
                    val paper=runBlocking {try{printer.diagnostics().paper.name}finally{printer.close()}}
                    state.put("sales",org.json.JSONArray(receipts.map{JSONObject().put("saleId",it.receipt.saleId).put("number",it.receipt.receiptNumber).put("method",it.receipt.paymentMethod).put("voided",it.void!=null)}))
                        .put("paper",paper).put("realPrints",0).put("offlineSalesSaved",true)
                    file("fiscal-offline.json").writeText(state.toString())
                } finally {db.close()}
            }
            "sync" -> {
                val repository=VanRepository.forWorker(context,false)
                try { runBlocking {repository.restoreSession();repository.syncNow()}
                    val state=JSONObject(file("fiscal-offline.json").readText())
                    val db=EncryptedVanDatabase.open(context)
                    try {runBlocking {
                        val ops=db.rows().outboxRows(state.getString("subject"),state.getString("deviceId"))
                        assertTrue(ops.filter{it.kind in listOf("sale.record","sale.void")}.all{it.status=="done"})
                        file("fiscal-synced.json").writeText(state.put("acknowledged",true).toString())
                    }}finally{db.close()}
                }finally{repository.close()}
            }
        }
    }
}
