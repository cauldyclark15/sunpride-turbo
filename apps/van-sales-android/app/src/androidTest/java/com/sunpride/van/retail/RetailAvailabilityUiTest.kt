package com.sunpride.van.retail

import androidx.activity.ComponentActivity
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import com.sunpride.van.AppEnvironment
import com.sunpride.van.ui.SaleScreen
import com.sunpride.van.ui.VanController
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*

/** Real SaleScreen embeds the real shared Compose UI; controller and repository write isolated SQLCipher Room. */
class RetailAvailabilityUiTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private lateinit var f: RetailRoomFixture
    private lateinit var c: VanController
    private var mounted by mutableStateOf(true)
    @Before fun open() { f=RetailRoomFixture(); f.ready(); c=VanController(f.repository(),AppEnvironment("https://retail.invalid")) }
    @After fun close() {
        rule.runOnUiThread { mounted=false }
        rule.waitForIdle() // cancel Room collectors before the fixture's database is closed
        f.close()
    }
    private fun mount() {
        rule.setContent { if(mounted) MaterialTheme {
            LaunchedEffect(c) { c.run(restore=false) } // no sign-in/bootstrap, fixture's authorized store only
            SaleScreen(c)
        } }
        rule.waitUntil(10_000) { c.initialized && c.trip!=null && c.products.size==2 && c.customers.isNotEmpty() }
        rule.runOnUiThread { c.startSale(c.customers.single { it.outletId==f.outlet }) }
        rule.waitUntil(10_000) { c.retailLoaded && c.retailCall!=null }
    }
    private fun quantity(index: Int,value: String) {
        rule.onNodeWithTag("retail-quantity-$index").performScrollTo().performTextReplacement(value)
        Espresso.closeSoftKeyboard()
    }
    @Test fun F212_incompleteChecklistDisablesSaveAndSaleCheckoutEvenWithACart() {
        mount()
        rule.runOnUiThread { c.addToSale(f.product,1) }
        rule.onNodeWithTag("checkout").assertIsNotEnabled()
        rule.onNodeWithTag("retail-save").performScrollTo().assertIsNotEnabled()
        rule.onNodeWithTag("retail-absent-0").performScrollTo().performClick()
        rule.onNodeWithTag("retail-completeness").performScrollTo().assertTextEquals("1 / 2 MSL lines checked")
        rule.onNodeWithTag("retail-save").performScrollTo().assertIsNotEnabled()
        rule.onNodeWithTag("checkout").assertIsNotEnabled()
        assertTrue(runBlocking { f.store.pending().isEmpty() }); assertFalse(c.retailSaved)
    }
    @Test fun F213_F218_F219_absentSkuExplainsAndPreparesEditableCartWithoutPostingSale() {
        mount()
        rule.onNodeWithTag("retail-absent-0").performScrollTo().performClick()
        rule.onNodeWithTag("retail-oos-reason-0").performScrollTo().assertTextEquals("Absent MSL line — proposed automatically")
        rule.onNodeWithText("MSL minimum: 3 base units").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Focus SKU: launch priority").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Objective: Build first order").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("retail-quantity-0").assertTextContains("3")
        rule.onNodeWithText("Days of cover: replenish 2 base units").performScrollTo().assertIsDisplayed()
        quantity(0,"5"); quantity(1,"0")
        rule.onNodeWithTag("retail-present-1").performScrollTo().performClick()
        rule.onNodeWithTag("retail-save").performScrollTo().assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.retailSaved && !c.busy && c.sale?.lines?.singleOrNull()?.quantityBase==5L }
        rule.onNodeWithTag("retail-completeness").performScrollTo().assertTextEquals("Complete · saved on this phone")
        rule.onNodeWithTag("checkout").assertIsEnabled()
        rule.onNodeWithTag("cart-bar").performClick()
        rule.onNodeWithTag("line-qty-0",useUnmergedTree=true).assertTextContains("5 PC",substring=true)
        rule.onNodeWithTag("line-0-qty").performClick()
        rule.onNodeWithTag("qty-key-7").performClick()
        rule.onNodeWithTag("save-quantity").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.sale?.lines?.singleOrNull()?.quantityBase==7L }
        assertEquals(f.product,c.sale!!.lines.single().productId)
        val rows=runBlocking { f.store.pending() }
        assertEquals(listOf("availability.record","availability.proposal"),rows.map { it.kind })
        val decision=JSONObject(rows[1].operationJson).getJSONObject("payload")
        assertEquals("accepted",decision.getString("decision")); assertEquals(5L,decision.getLong("quantityBase"))
        assertEquals(c.sale!!.saleId,decision.getString("orderKey"))
        assertTrue(runBlocking { f.db.rows().saleRows(f.scope.fullAuthSubject,f.scope.deviceId).isEmpty() })
        assertEquals(20L,runBlocking { f.store.stock().single { it.productId==f.product }.availableBase })
    }
    @Test fun F212_scanAndF213_zeroDismissalRetainMethodAndDoNotAddAProduct() {
        mount()
        rule.onNodeWithTag("retail-scan").performScrollTo().performTextInput("unknown")
        Espresso.closeSoftKeyboard()
        rule.onNodeWithText("Mark scanned product present").performScrollTo().performClick()
        rule.onNodeWithText("Not a unique MSL barcode. Tap the product instead.").performScrollTo().assertIsDisplayed()
        rule.onNodeWithTag("retail-completeness").performScrollTo().assertTextEquals("0 / 2 MSL lines checked")
        rule.onNodeWithTag("retail-scan").performScrollTo().performTextReplacement("barcode-${f.second}")
        Espresso.closeSoftKeyboard()
        rule.onNodeWithText("Mark scanned product present").performScrollTo().performClick()
        rule.onNodeWithTag("retail-present-1").performScrollTo().assertIsSelected()
        rule.onNodeWithTag("retail-absent-0").performScrollTo().performClick()
        quantity(0,"-1"); quantity(1,"0")
        rule.onNodeWithTag("retail-save").performScrollTo().performClick()
        rule.onNodeWithText("Use whole non-negative quantities").performScrollTo().assertIsDisplayed()
        assertTrue(runBlocking { f.store.pending().isEmpty() })
        quantity(0,"0")
        rule.onNodeWithTag("retail-save").performScrollTo().performClick()
        rule.waitUntil(10_000) { c.retailSaved && !c.busy }
        assertTrue(c.sale!!.lines.isEmpty()); rule.onNodeWithTag("checkout").assertIsNotEnabled()
        val rows=runBlocking { f.store.pending() }
        val check=JSONObject(rows[0].operationJson).getJSONObject("payload")
        assertEquals("scan",check.getJSONArray("lines").getJSONObject(1).getString("method"))
        val decision=JSONObject(rows[1].operationJson).getJSONObject("payload")
        assertEquals("dismissed",decision.getString("decision")); assertTrue(decision.isNull("orderKey"))
    }
}
