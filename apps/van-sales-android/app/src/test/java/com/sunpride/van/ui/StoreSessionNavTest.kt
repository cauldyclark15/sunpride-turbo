package com.sunpride.van.ui

import com.sunpride.van.storepos.StoreXPreview
import org.junit.Assert.*
import org.junit.Test

/** IP-P0 (SPEC 7.1): opening a session goes to Store home; the count is only reachable through the End session sheet. */
class StoreSessionNavTest {
    private val home = StoreNav()
    private fun run(start: StoreNav, shiftOpen: Boolean, vararg events: StoreNavEvent) =
        events.fold(start) { s, e -> StoreSessionNav.reduce(s,e,shiftOpen) }

    @Test fun openThenSavedLandsOnHomeNotOnTheCount() {
        val opening = run(home,false,StoreNavEvent.OpenTapped)
        assertEquals(Page.STORE_OPEN,opening.page)
        val saved = run(opening,true,StoreNavEvent.OpenSaved)
        assertEquals(Page.HOME,saved.page)
        assertFalse(saved.countUnlocked); assertFalse(saved.endSheet)
    }
    @Test fun noEventSequenceFromOpenReachesTheCount() {
        // Every path that starts at the open page, in either shift state, ends outside STORE_CLOSE.
        val events = listOf(StoreNavEvent.OpenTapped,StoreNavEvent.OpenSaved,StoreNavEvent.EndConfirmed,StoreNavEvent.EndCancelled,StoreNavEvent.Back)
        for (shiftOpen in listOf(false,true)) for (a in events) for (b in events) for (c in events) {
            val end = run(StoreNav(Page.STORE_OPEN),shiftOpen,a,b,c)
            assertNotEquals("$a $b $c shiftOpen=$shiftOpen",Page.STORE_CLOSE,end.page)
        }
    }
    @Test fun closeOnlyViaTheConfirmSheet() {
        // Confirm without the sheet shown does nothing.
        assertEquals(Page.HOME,run(home,true,StoreNavEvent.EndConfirmed).page)
        val sheet = run(home,true,StoreNavEvent.EndTapped)
        assertTrue(sheet.endSheet); assertEquals(Page.HOME,sheet.page)
        val count = run(sheet,true,StoreNavEvent.EndConfirmed)
        assertEquals(Page.STORE_CLOSE,count.page); assertTrue(count.countUnlocked)
        assertEquals(home,run(count,true,StoreNavEvent.CloseSaved))
    }
    @Test fun cancelAndBackLockTheCountAgain() {
        val sheet = run(home,true,StoreNavEvent.EndTapped)
        assertEquals(home,run(sheet,true,StoreNavEvent.EndCancelled))
        val count = run(sheet,true,StoreNavEvent.EndConfirmed)
        assertEquals(home,run(count,true,StoreNavEvent.Back))
    }
    @Test fun endSessionNeedsAnOpenSessionAndOpenNeedsNone() {
        assertEquals(home,run(home,false,StoreNavEvent.EndTapped))
        assertEquals(home,run(home,true,StoreNavEvent.OpenTapped))
        assertEquals(Page.STORE_OPEN,run(home,false,StoreNavEvent.OpenTapped).page)
    }
    @Test fun guardNeverShowsTheCountOrOpenFormInTheWrongSituation() {
        assertEquals(home,StoreSessionNav.guard(StoreNav(Page.STORE_CLOSE),true))
        assertEquals(home,StoreSessionNav.guard(StoreNav(Page.STORE_CLOSE,countUnlocked = true),false))
        assertEquals(StoreNav(Page.STORE_CLOSE,countUnlocked = true),StoreSessionNav.guard(StoreNav(Page.STORE_CLOSE,countUnlocked = true),true))
        assertEquals(home,StoreSessionNav.guard(StoreNav(Page.STORE_OPEN),true))
        assertFalse(StoreSessionNav.guard(StoreNav(endSheet = true),false).endSheet)
    }
    @Test fun genericOpenCannotJumpToTheCount() {
        assertFalse(StoreSessionNav.mayOpen(Page.STORE_CLOSE,home,true))
        assertTrue(StoreSessionNav.mayOpen(Page.STORE_CLOSE,StoreNav(Page.STORE_CLOSE,countUnlocked = true),true))
        assertFalse(StoreSessionNav.mayOpen(Page.STORE_OPEN,home,true))
        assertTrue(StoreSessionNav.mayOpen(Page.STORE_SALE,home,false))
    }
    @Test fun newSaleSaysWhyItIsDisabled() {
        assertEquals("Open a cashier session first",StoreNewSale.blockedReason(false,false,true,true))
        assertEquals("Sync to download prices",StoreNewSale.blockedReason(true,false,true,false))
        assertNotNull(StoreNewSale.blockedReason(true,true,true,true))
        assertNotNull(StoreNewSale.blockedReason(true,false,false,true))
        assertNull(StoreNewSale.blockedReason(true,false,true,true))
    }
    @Test fun xPreviewAddsSalesOnly() {
        assertEquals(StoreXPreview(0,0),StoreXPreview.of(emptyList()))
        assertEquals(StoreXPreview(2,350_00),StoreXPreview.of(listOf(100_00,250_00)))
    }
}
