package com.sunpride.van.storepos

import androidx.activity.ComponentActivity
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import com.sunpride.van.AppEnvironment
import com.sunpride.van.retail.RetailRoomFixture
import com.sunpride.van.ui.*
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.flow.first
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.util.UUID

/** F-R01: real SQLCipher Room and shared UI on the H10P; fixtures are explicitly isolated. */
class StorePosDeviceTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private lateinit var f:RetailRoomFixture
    private var mounted by mutableStateOf(false)
    private val mode=UUID.randomUUID().toString()
    private val register=UUID.randomUUID().toString()
    private fun snapshot():String {
        val o=JSONObject(f.snapshot())
        o.put("trip",JSONObject.NULL).put("load",JSONObject.NULL)
        o.getJSONObject("policy").put("storePos",JSONObject().put("version",1).put("mode","store").put("modeVersionId",mode)
            .put("registerId",register).put("registerName","Sample register 1").put("storeName","Sample Cebu Colon store")
            .put("terminalCode","CEBU-COLON-01").put("policyId",UUID.randomUUID().toString()).put("shift",JSONObject.NULL)
            .put("allowLocalSwitch",false).put("transactionsEnabled",false))
        return o.toString()
    }
    @Before fun open() {f=RetailRoomFixture();runBlocking{f.store.replaceBootstrap(snapshot())}}
    @After fun close() {rule.runOnUiThread{mounted=false};rule.waitForIdle();f.close()}
    @Test fun F_R01_offlineSessionSurvivesDatabaseReopenWithImmutableOrderedOperations()=runBlocking {
        val session=StorePosStore(f.store)
        val id=session.open(100_000)
        val bytes=f.store.pending().single().operationJson
        f.reopen()
        val reopened=StorePosStore(f.store)
        assertEquals(id,reopened.state.first().shift!!.shiftId)
        assertEquals(bytes,f.store.pending().single().operationJson)
        reopened.close(99_000)
        val rows=f.store.pending()
        assertEquals(listOf("store.shift.open","store.shift.close"),rows.map{it.kind})
        assertTrue(rows[1].createdAt>rows[0].createdAt)
        val close=JSONObject(rows[1].operationJson)
        assertEquals(rows[0].clientRequestId,close.getJSONArray("dependsOn").getString(0))
        assertFalse(close.getJSONObject("payload").has("expectedCentavos"))
        f.reopen()
        assertNull(StorePosStore(f.store).state.first().shift)
        f.store.hold()
        assertTrue(runCatching{StorePosStore(f.store).open(0)}.isFailure)
        Unit
    }
    /** IP-P0 (SPEC 7.1): opening goes to Home with New sale ready; the blind count is only behind End session -> confirm. */
    @Test fun F_R01_storeScreensHideVanActionsAndKeepBlindCountClearOfSystemBars() {
        val c=VanController(f.repository(),AppEnvironment("https://retail.invalid"))
        mounted=true
        rule.setContent{if(mounted)VanApp(c,restore=false)}
        rule.waitUntil(10_000){c.initialized && c.storeMode}
        rule.onNodeWithTag("store-open-session").assertIsDisplayed()
        rule.onNodeWithTag("store-end-session").assertDoesNotExist()
        rule.onNodeWithTag("open-customers").assertDoesNotExist()
        rule.onNodeWithTag("open-route-ops").assertDoesNotExist()
        rule.onNodeWithTag("store-session-status").assertTextEquals("Closed")
        rule.onNodeWithTag("nav-sell").performClick(); rule.onNodeWithText("Open the till to start selling").assertIsDisplayed(); rule.onNodeWithTag("nav-till").performClick()
        captureVanScreenshot(rule,"retail-store-home","store-open-session")
        rule.onNodeWithTag("store-open-session").performClick()
        rule.onNodeWithTag("screen-title").assertTextEquals("Open the till")
        captureVanScreenshot(rule,"retail-opening-float","save-store-open")
        rule.onNodeWithTag("store-float-amount").performTextInput("1000")
        Espresso.closeSoftKeyboard()
        rule.onNodeWithTag("save-store-open").performClick()
        rule.waitUntil(10_000){!c.busy && c.storePos.shift!=null}
        // After open: Store home, never the count.
        rule.waitUntil(10_000){c.page!=Page.STORE_OPEN}
        rule.onNodeWithTag("nav-till").performClick()
        rule.onNodeWithTag("store-session-status").assertTextEquals("Open")
        rule.onNodeWithTag("store-count-amount").assertDoesNotExist()
        rule.onNodeWithTag("save-store-close").assertDoesNotExist()
        rule.onNodeWithText("Blind cash count").assertDoesNotExist()
        rule.onNodeWithTag("store-open-session").assertDoesNotExist()
        // New sale is enabled once the office has switched selling on; this fixture leaves it off, so it must say why.
        if(c.storePos.config?.details?.optBoolean("transactionsEnabled")==true) rule.onNodeWithTag("store-new-sale").performScrollTo().assertIsEnabled()
        else rule.onNodeWithTag("store-new-sale-reason").performScrollTo().assertIsDisplayed()
        captureVanScreenshot(rule,"retail-session-open-home","store-new-sale")
        // End session is a secondary row that asks first, with the X reading, before any count.
        rule.onNodeWithTag("store-end-session").performScrollTo().performClick()
        rule.onNodeWithTag("end-session-title").assertIsDisplayed()
        rule.onNodeWithTag("end-session-x").assertIsDisplayed()
        rule.onNodeWithText("Expected",substring=true).assertDoesNotExist()
        rule.onNodeWithTag("store-end-cancel").performClick()
        rule.onNodeWithTag("end-session-title").assertDoesNotExist()
        assertNotNull(c.storePos.shift)
        rule.onNodeWithTag("store-end-session").performScrollTo().performClick()
        rule.onNodeWithTag("store-end-continue").performClick()
        rule.onNodeWithTag("screen-title").assertTextEquals("Blind cash count")
        rule.onNodeWithText("Expected",substring=true).assertDoesNotExist()
        captureVanScreenshot(rule,"retail-blind-count","save-store-close")
        rule.onNodeWithTag("store-count-amount").performTextInput("990")
        Espresso.closeSoftKeyboard()
        rule.onNodeWithTag("save-store-close").performClick()
        rule.waitUntil(10_000){!c.busy && c.page==Page.HOME && c.storePos.shift==null}
        captureVanScreenshot(rule,"retail-closed-session","store-open-session")
        rule.onNodeWithTag("nav-more").performClick()
        rule.onNodeWithTag("open-pos-mode").performScrollTo().performClick()
        rule.onNodeWithTag("pos-mode-value").assertTextEquals("Store")
        captureVanScreenshot(rule,"retail-mode-settings","primary")
    }
}
