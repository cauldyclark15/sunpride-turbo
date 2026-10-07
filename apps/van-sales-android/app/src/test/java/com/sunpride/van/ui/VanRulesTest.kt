package com.sunpride.van.ui

import com.sunpride.van.data.*
import org.junit.Assert.*
import org.junit.Test

class VanRulesTest {
    private fun trip(status: String, pending: Boolean = false) = Trip("trip","Trip 1",status,"2026-10-07",Vehicle("truck","V014","NBC 1234",null),Route("route","R1","North"),"Pedro",null,"stock",null,null,pending)
    private val planned = Load("load","planned",emptyList())
    @Test fun primaryActionUsesServerLoadAndTripState() {
        assertEquals(NextAction(Page.LOAD,"Check the load"),VanRules.nextAction(trip("loading"),planned))
        assertEquals(NextAction(Page.START,"Start trip"),VanRules.nextAction(trip("loaded"),planned))
        listOf("planned","active","closing","closed","cancelled").forEach { assertEquals(Page.CUSTOMERS,VanRules.nextAction(trip(it),planned).page) }
        assertEquals(Page.CUSTOMERS,VanRules.nextAction(trip("loading"),planned.copy(confirmPending = true)).page)
        assertEquals(Page.CUSTOMERS,VanRules.nextAction(trip("loading"),planned.copy(status = "discrepancy")).page)
        assertEquals(Page.CUSTOMERS,VanRules.nextAction(trip("loaded",true),planned).page)
    }
    @Test fun plainStatusLabelsNeverShowWireEnums() {
        assertEquals("Planned",VanRules.status(trip("planned"),planned))
        assertEquals("Loading",VanRules.status(trip("loading"),planned))
        assertEquals("Load waiting for supervisor",VanRules.status(trip("loading"),planned.copy(status = "discrepancy")))
        assertEquals("Loaded — ready to start",VanRules.status(trip("loaded"),planned))
        assertEquals("On route",VanRules.status(trip("active"),planned))
        assertEquals("Closing…",VanRules.status(trip("closing"),planned))
        assertEquals("Load sent — waiting for sync",VanRules.status(trip("loading"),planned.copy(confirmPending = true)))
    }
    @Test fun scaledQuantitiesAreExactAndDoNotTruncate() {
        assertEquals("48",VanRules.quantity(48,1))
        assertEquals("1.25",VanRules.quantity(1250,1000))
        assertEquals("0.005",VanRules.quantity(5,1000))
        assertEquals(1250L,VanRules.parseQuantity("1.25",1000))
        assertEquals(0L,VanRules.parseQuantity("0",1))
        assertNull(VanRules.parseQuantity("1.25",1))
        assertNull(VanRules.parseQuantity("-1",1))
        assertNull(VanRules.parseQuantity("9999999999999999999",1000))
        assertNull(VanRules.parseQuantity("",1))
        assertNull(VanRules.parseQuantity("bad",1))
    }
    @Test fun changedQuantityRequiresReasonAndStartNeedsBothConfirmations() {
        assertFalse(VanRules.reasonRequired(48,48))
        assertTrue(VanRules.reasonRequired(48,47))
        assertTrue(VanRules.reasonRequired(48,49))
        assertFalse(VanRules.reasonRequired(48,null))
        assertFalse(VanRules.canStart(trip("loading"),true,true))
        assertFalse(VanRules.canStart(trip("loaded"),false,true))
        assertFalse(VanRules.canStart(trip("loaded"),true,false))
        assertFalse(VanRules.canStart(trip("loaded",true),true,true))
        assertFalse(VanRules.canStart(trip("loaded").copy(vehicle = null),true,true))
        assertFalse(VanRules.canStart(null,true,true))
        assertTrue(VanRules.canStart(trip("loaded"),true,true))
    }
}
