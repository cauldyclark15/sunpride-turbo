package com.sunpride.field.ui

import org.junit.Assert.assertEquals
import org.junit.Test

/** SP-0141: the phone's Back key follows the on-screen ‹ one step at a time; only Today leaves the app. */
class BackNavigationTest {
    private val visit = BackState(page = "customer", visitOpen = true)

    @Test fun visitStackUnwindsOneStepAtATime() {
        assertEquals(BackStep.ClosePhoto, BackNavigation.step(visit.copy(photoCaptureOpen = true, callSheetOpen = true)))
        assertEquals(BackStep.CloseActivityForm, BackNavigation.step(visit.copy(activityFormOpen = true)))
        assertEquals(BackStep.CloseOrderReview, BackNavigation.step(visit.copy(orderOpen = true, orderReview = true, callSheetOpen = true)))
        assertEquals(BackStep.CloseOrder, BackNavigation.step(visit.copy(orderOpen = true, callSheetOpen = true)))
        assertEquals(BackStep.CloseCallSheet, BackNavigation.step(visit.copy(callSheetOpen = true)))
        assertEquals(BackStep.CloseVisit, BackNavigation.step(visit))
    }

    @Test fun pagesWalkBackToTodayThenTheAppMayClose() {
        assertEquals(BackStep.ToPage("customers"), BackNavigation.step(BackState(page = "customer")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "customers")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "route")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "team")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "sync")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "account")))
        assertEquals(BackStep.ToPage("account"), BackNavigation.step(BackState(page = "support")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "location-consent")))
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "location-background")))
        assertEquals(BackStep.Exit, BackNavigation.step(BackState(page = "home")))
    }

    @Test fun accountOverAVisitReturnsToTheVisitScreenNotOutOfIt() {
        // Account is drawn above the visit; Back closes Account and the visit is still open underneath.
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(visit.copy(page = "account", callSheetOpen = true)))
    }

    @Test fun signInUnlockAndWaitingScreensLeaveBackToTheSystem() {
        assertEquals(BackStep.Exit, BackNavigation.step(BackState(signedIn = false, page = "customer")))
        assertEquals(BackStep.Exit, BackNavigation.step(BackState(locked = true, page = "customers", visitOpen = true)))
        assertEquals(BackStep.Exit, BackNavigation.step(BackState(ready = false, page = "customers")))
        assertEquals(BackStep.Exit, BackNavigation.step(BackState(ready = false, visitOpen = true)))
    }
}
