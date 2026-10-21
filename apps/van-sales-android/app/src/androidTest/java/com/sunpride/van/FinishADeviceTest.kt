package com.sunpride.van

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.retail.RetailRoomFixture
import com.sunpride.van.ui.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.File

/** Short H10P screen pass; isolated encrypted sample trip, no live account/network, scanner or paper. */
class FinishADeviceTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private fun capture(name:String){
        val instrumentation=InstrumentationRegistry.getInstrumentation()
        val bitmap=checkNotNull(instrumentation.uiAutomation.takeScreenshot())
        File(instrumentation.targetContext.getExternalFilesDir(null),"finish-a-$name.png").outputStream().use{bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG,100,it)}
        bitmap.recycle()
    }
    @Test fun F110_F112_F124_F404_newCartControlsKeepReasonsAndSAPDisclaimer(){
        val f=RetailRoomFixture();f.ready()
        val c=VanController(f.repository(),AppEnvironment("https://sample.invalid"))
        var mounted by mutableStateOf(true)
        var scene by mutableIntStateOf(0)
        try{
            rule.setContent{if(mounted)MaterialTheme{
                LaunchedEffect(c){c.run(restore=false)}
                when(scene){
                    0->Column(Modifier.fillMaxSize().statusBarsPadding().navigationBarsPadding().verticalScroll(rememberScrollState())){SaleCreditPanel(c,{})}
                    1->DiscountDialog(c,{scene=2})
                    2->PriceOverrideDialog(c,{scene=3})
                    else->Column{FinancialApprovalCard(c,"price")}
                }
            }}
            rule.waitUntil(10_000){c.initialized&&c.trip!=null&&c.customers.isNotEmpty()}
            rule.runOnIdle{c.startSale(c.customers.single{it.outletId==f.outlet});c.addToSale(f.product,1)}
            rule.waitUntil(10_000){c.sale!=null&&c.cartQuote()!=null}
            rule.onNodeWithTag("credit-status").assertIsDisplayed();capture("sap-credit")
            rule.onNodeWithText("SAP credit exception").performScrollTo().assertIsDisplayed()
            rule.onNodeWithTag("sap-credit-reason").performScrollTo().performTextInput("SAMPLE source-order credit review")
            Espresso.closeSoftKeyboard()
            rule.onNodeWithTag("sap-credit-request").performScrollTo().assertIsEnabled();capture("sap-exception")
            rule.runOnIdle{scene=1}
            rule.onNodeWithTag("discount-line-0").performScrollTo().performTextInput("1.00")
            rule.onNodeWithTag("discount-reason").performScrollTo().performTextInput("SAMPLE route discount")
            Espresso.closeSoftKeyboard();capture("discount")
            rule.onNodeWithTag("apply-discounts").assertIsEnabled().performClick()
            rule.onNodeWithTag("price-override-0").performScrollTo().performTextInput("9.00")
            rule.onNodeWithTag("price-override-reason").performScrollTo().performTextInput("SAMPLE negotiated base price")
            Espresso.closeSoftKeyboard();capture("price")
            rule.onNodeWithTag("apply-price-override").assertIsEnabled().performClick()
            rule.runOnIdle{
                assertEquals(100L,c.sale!!.manualDiscount!!.lineMinor[f.product])
                assertEquals(900L,c.sale!!.priceOverride!!.unitMinor[f.product])
                assertEquals("SAMPLE negotiated base price",c.sale!!.priceOverride!!.authorization.reason)
            }
        }finally{rule.runOnUiThread{mounted=false};rule.waitForIdle();f.close()}
    }
}
