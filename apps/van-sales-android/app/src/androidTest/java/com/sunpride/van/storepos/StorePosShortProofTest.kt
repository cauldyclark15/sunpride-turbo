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
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import java.io.File

/** F-R01/R02/R03 single opt-in live pass. Host controls network under the H10P wrapper lock.
 * No old van/field flows, biometric prompt, physical print or full instrumentation suite. */
class StorePosShortProofTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private fun file(name:String)=File(context.filesDir,name)
    private fun ready(c:VanController)=rule.waitUntil(20_000){c.initialized&&!c.busy&&c.session.signedIn&&c.storeMode&&c.storePos.config!=null}
    private fun capture(name:String)=captureVanScreenshot(rule,name)
    private fun home(c:VanController){rule.runOnIdle{c.open(Page.HOME)};rule.waitForIdle()}
    private fun signal(name:String){file("retail-short-signal").writeText(name)}
    private fun awaitHost(name:String){
        val until=System.nanoTime()+45_000_000_000L
        while(!file(name).exists()&&System.nanoTime()<until)Thread.sleep(100)
        check(file(name).exists()){"Host network coordination did not complete"};file(name).delete()
    }
    @Test fun F_R01_R02_R03_one_short_store_mode_pass(){
        assumeTrue(InstrumentationRegistry.getArguments().getString("retailShortProof")=="true")
        check(BuildConfig.API_ORIGIN=="http://127.0.0.1:4590"){"Use the isolated retail lane API only"}
        val repository=VanRepository.forWorker(context,false)
        val c=VanController(repository,AppEnvironment(BuildConfig.API_ORIGIN))
        val mounted=androidx.compose.runtime.mutableStateOf(true)
        try{
            rule.setContent{if(mounted.value)VanApp(c,restore=false)}
            val login=JSONObject(file("retail-short-login.json").readText());file("retail-short-login.json").delete()
            rule.waitUntil(20_000){rule.onAllNodesWithTag("email").fetchSemanticsNodes().isNotEmpty()}
            rule.onNodeWithTag("email").performTextInput(login.getString("email"))
            rule.onNodeWithTag("password").performTextInput(login.getString("password"));login.remove("password")
            Espresso.closeSoftKeyboard();rule.onNodeWithTag("sign-in").performClick();ready(c)
            assertNull(c.storePos.shift);capture("retail-short-home")
            rule.onNodeWithTag("store-open-session").performClick()
            rule.onNodeWithTag("store-float-amount").performTextInput("1000");Espresso.closeSoftKeyboard();capture("retail-short-opening")
            rule.onNodeWithTag("save-store-open").performClick()
            rule.waitUntil(20_000){!c.busy&&c.storePos.shift!=null}
            val config=checkNotNull(c.storePos.config)
            val product=StoreCheckout.products(config).first {p->runCatching{StoreCheckout.quote(config,c.storePos.rows,listOf(com.sunpride.van.pos.CartLine(p.productId,p.quantityScale)),System.currentTimeMillis())}.isSuccess}
            fun takeSale(label:String){
                home(c);rule.onNodeWithTag("store-new-sale").performScrollTo().performClick()
                rule.onNodeWithTag("store-product-search").performTextInput(product.code);Espresso.closeSoftKeyboard()
                rule.onNodeWithTag("store-add-${product.code}").performScrollTo().performClick()
                capture("retail-short-$label-cart")
                val before=c.storePos.rows.count{it.kind=="store.sale"}
                rule.onNodeWithTag("save-store-sale").assertIsEnabled().performClick()
                rule.waitUntil(20_000){!c.busy&&c.page==Page.STORE_RECEIPTS&&c.storePos.rows.count{it.kind=="store.sale"}==before+1}
                capture("retail-short-$label-receipt")
            }
            takeSale("online")
            rule.runOnIdle{c.syncNow()};rule.waitUntil(20_000){!c.busy&&c.storePos.queued==0}
            assertEquals(0,c.storePos.review)
            home(c);rule.runOnIdle{c.open(Page.STORE_READS)};rule.waitForIdle();capture("retail-short-x-report")
            rule.onNodeWithTag("store-x-read").performScrollTo().performClick();rule.waitUntil(20_000){!c.busy&&c.page==Page.HOME}
            for((page,label)in listOf(Page.STORE_STOCK to "stock",Page.STORE_DEPOSIT to "deposit",Page.STORE_CUSTOMERS to "customers",Page.POS_MODE to "settings")){
                rule.runOnIdle{c.open(page)};rule.waitForIdle();capture("retail-short-$label")
            }
            home(c);signal("offline");awaitHost("retail-short-offline-ready")
            takeSale("offline")
            assertTrue(c.storePos.queued>0);home(c);capture("retail-short-offline-saved")
            signal("online");awaitHost("retail-short-online-ready")
            rule.runOnIdle{c.syncNow()};rule.waitUntil(20_000){!c.busy&&c.storePos.queued==0}
            assertEquals(0,c.storePos.review);capture("retail-short-synced")
            rule.runOnIdle{c.open(Page.STORE_READS)};rule.waitForIdle();capture("retail-short-received-x")
            rule.onNodeWithTag("store-z-read").performScrollTo().performClick();rule.waitUntil(20_000){!c.busy&&c.page==Page.HOME}
            home(c);rule.onNodeWithTag("store-end-session").performScrollTo().performClick();rule.onNodeWithTag("store-end-continue").performClick()
            rule.onNodeWithTag("store-count-amount").performTextInput("1000");Espresso.closeSoftKeyboard();capture("retail-short-blind-count")
            rule.onNodeWithTag("save-store-close").performClick();rule.waitUntil(20_000){!c.busy&&c.storePos.shift==null}
            rule.runOnIdle{c.syncNow()};rule.waitUntil(20_000){!c.busy&&c.storePos.queued==0}
            assertEquals(0,c.storePos.review);capture("retail-short-day-closed")
            signal("done")
        }finally{rule.runOnUiThread{mounted.value=false};rule.waitForIdle();repository.close()}
    }
}
