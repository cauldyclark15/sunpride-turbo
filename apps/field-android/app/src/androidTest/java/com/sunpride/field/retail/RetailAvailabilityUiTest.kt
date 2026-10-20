package com.sunpride.field.retail

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.espresso.Espresso
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.orders.OrderDraftScreen
import com.sunpride.retail.RetailAvailabilityStep
import kotlinx.coroutines.*
import org.junit.*
import org.junit.Assert.*

/** Production shared Compose step → FieldController → LiveFieldBackend → isolated SQLCipher Room. */
class RetailAvailabilityUiTest {
    @get:Rule val rule=createAndroidComposeRule<ComponentActivity>()
    private lateinit var f: RetailRoomFixture
    private lateinit var c: FieldController
    private lateinit var lifetime: CoroutineScope
    private val visit=VisitDisplay("Retail fixture store","Planned","In progress","outlet-retail","planned-retail")
    @Before fun open() {
        f=RetailRoomFixture(); f.ready()
        lifetime=CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
        rule.runOnUiThread { c=FieldController(f.backend,lifetime); c.openDiagnostic(visit) }
        rule.waitUntil(10_000) { c.retailCall!=null }
    }
    @After fun close() { lifetime.cancel(); rule.waitForIdle(); f.close() }
    private fun mount() {
        rule.setContent { MaterialTheme {
            if(c.orderOpen)OrderDraftScreen(visit,requireNotNull(c.diagnosticCallSheet),c)
            else Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
                RetailAvailabilityStep(requireNotNull(c.retailCall),c.busy,c.retailSaved) { a,q -> c.saveRetail(a,q) }
            }
        } }
    }
    private fun quantity(index: Int,value: String) {
        rule.onNodeWithTag("retail-quantity-$index").performScrollTo().performTextReplacement(value)
        Espresso.closeSoftKeyboard()
    }
    @Test fun F212_partialChecklistNeverEnablesSaveOrEndCall() {
        mount()
        rule.onNodeWithTag("retail-completeness").assertTextEquals("0 / 2 MSL lines checked")
        rule.onNodeWithTag("retail-save").performScrollTo().assertIsNotEnabled()
        rule.onNodeWithTag("retail-absent-0").performScrollTo().performClick()
        rule.onNodeWithTag("retail-completeness").performScrollTo().assertTextEquals("1 / 2 MSL lines checked")
        rule.onNodeWithTag("retail-save").performScrollTo().assertIsNotEnabled()
        rule.runOnUiThread { c.reviewEnd("completed",null) }
        rule.waitUntil(10_000) { !c.busy && c.diagnosticError!=null }
        assertNull(c.endReview); assertFalse(c.retailSaved)
        assertEquals(listOf("visit.checkIn"),f.backend.visitStates().map { it.first.kind })
    }
    @Test fun F213_F218_F219_absentSkuExplainsProposalAndOpensAStillEditableOrder() {
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
        rule.onNodeWithTag("retail-completeness").performScrollTo().assertTextEquals("2 / 2 MSL lines checked")
        rule.onNodeWithTag("retail-save").performScrollTo().assertIsEnabled().performClick()
        rule.waitUntil(10_000) { c.orderOpen && !c.busy }
        assertNull(c.diagnosticError); assertTrue(c.retailSaved)
        rule.onNodeWithTag("order-products").performScrollToNode(hasTestTag("order-qty-p-absent"))
        rule.onNodeWithTag("order-qty-p-absent").assertTextContains("5").performTextReplacement("7")
        Espresso.closeSoftKeyboard()
        rule.onNodeWithTag("order-save").assertIsEnabled().performClick()
        rule.waitUntil(10_000) { !c.busy && c.openOrderDraft?.lines?.singleOrNull()?.quantity==7 }
        val draft=f.backend.orderDrafts().single()
        assertEquals("p-absent",draft.lines.single().productId); assertNull(draft.submittedRequestId)
        assertEquals(listOf("visit.checkIn","availability.record","availability.proposal"),f.backend.visitStates().map { it.first.kind })
        f.reopen(); assertEquals(7,f.backend.orderDrafts().single().lines.single().quantity)
    }
    @Test fun F212_scanAndF213_zeroDismissalPersistWithoutSendingAnOrder() {
        mount()
        rule.onNodeWithTag("retail-scan").performScrollTo().performTextInput("barcode-p-present")
        Espresso.closeSoftKeyboard()
        rule.onNodeWithText("Mark scanned product present").performScrollTo().performClick()
        rule.onNodeWithTag("retail-present-1").performScrollTo().assertIsSelected()
        rule.onNodeWithTag("retail-absent-0").performScrollTo().performClick()
        quantity(0,"-1"); quantity(1,"0")
        rule.onNodeWithTag("retail-save").performScrollTo().performClick()
        rule.onNodeWithText("Use whole non-negative quantities").performScrollTo().assertIsDisplayed()
        assertEquals(1,f.backend.visitStates().size)
        quantity(0,"0")
        rule.onNodeWithTag("retail-save").performScrollTo().performClick()
        rule.waitUntil(10_000) { c.retailSaved && !c.busy }
        rule.onNodeWithTag("retail-completeness").performScrollTo().assertTextEquals("Complete · saved on this phone")
        assertTrue(f.backend.orderDrafts().isEmpty())
        val check=org.json.JSONObject(f.backend.visitStates()[1].first.serializedOperation).getJSONObject("payload")
        assertEquals("scan",check.getJSONArray("lines").getJSONObject(1).getString("method"))
        val decision=org.json.JSONObject(f.backend.visitStates().last().first.serializedOperation).getJSONObject("payload")
        assertEquals("dismissed",decision.getString("decision")); assertTrue(decision.isNull("orderKey"))
    }
}
