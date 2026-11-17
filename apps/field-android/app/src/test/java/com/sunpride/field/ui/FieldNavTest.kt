package com.sunpride.field.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The bottom bar: five tabs, every page belongs to one, and the bar steps aside inside flows. */
class FieldNavTest {
    // E2E-001: finishing registration (or sign-in) lands on Today, not a leftover tab such as Customers.
    @Test fun `E2E-001 becoming ready opens on Today`() {
        assertEquals("home", FieldNav.pageOnReady(wasReady = false, ready = true, page = "customers"))
        assertEquals("customers", FieldNav.pageOnReady(wasReady = true, ready = true, page = "customers"))
        assertEquals("messages", FieldNav.pageOnReady(wasReady = false, ready = true, page = "messages", targeted = true))
    }

    // E2E-001 r6: Register phone → Check again still opened on Customers. While Register phone shows, the page
    // behind it returns to Today (Account/Support stay reachable), so Check again opens on Today.
    @Test fun `E2E-001 the register screen resets a leftover tab so Check again opens on Today`() {
        assertEquals("home", FieldNav.pageWhileWaiting("customers"))
        assertEquals("home", FieldNav.pageWhileWaiting("customer"))
        assertEquals("account", FieldNav.pageWhileWaiting("account"))
        assertEquals("support", FieldNav.pageWhileWaiting("support"))
        // Check again: ready arrives with wasReady still true (the not-ready step was never observed) and the
        // page is already Today.
        assertEquals("home", FieldNav.pageOnReady(wasReady = true, ready = true, page = FieldNav.pageWhileWaiting("customers")))
    }

    // SP-0195: each App mode shows only its own places, never more than four, with Messages off the bar.
    @Test fun tabsPerModeNeverMoreThanFour() {
        assertEquals(listOf("Home", "Customers", "More"), FieldNav.tabs(AppMode.MAPPING).map { it.label })
        assertEquals(listOf("Today", "Route", "Customers", "More"), FieldNav.tabs(AppMode.VISITS).map { it.label })
        assertEquals(listOf("Today", "Sell", "Customers", "More"), FieldNav.tabs(AppMode.SELLING).map { it.label })
        for (mode in AppMode.entries) {
            val tabs = FieldNav.tabs(mode)
            assertTrue(mode.name, tabs.size <= FieldNav.MAX_TABS)
            assertFalse("Messages is a top-bar icon, never a tab", FieldTab.MESSAGES in tabs)
            assertEquals(tabs.size, tabs.map { it.tag }.toSet().size)
            assertEquals("every mode's first tab is its Home", "home", tabs.first().page)
        }
        assertFalse(FieldTab.SELL in FieldNav.tabs(AppMode.VISITS))
        assertFalse(FieldTab.SELL in FieldNav.tabs(AppMode.MAPPING))
        assertEquals(FieldTab.SELL, FieldNav.tabOf("sell"))
        assertTrue("sell" in FieldNav.tabRoots)
        assertFalse("sell" in FieldNav.noBarPages)
        // Four labels or fewer keep the normal size (the old six-tab shrink is gone).
        assertEquals(FieldNav.MAX_BAR_LABEL_SCALE, FieldNav.barLabelFontScale(2f))
        assertEquals(0.9f, FieldNav.barLabelFontScale(0.9f))
    }

    @Test fun homeIsTheMappingHomeInMappingModeAndTodayElsewhere() {
        assertEquals(FieldTab.HOME, FieldNav.tabOf("home", AppMode.MAPPING))
        assertEquals(FieldTab.TODAY, FieldNav.tabOf("home", AppMode.VISITS))
        assertEquals(FieldTab.TODAY, FieldNav.tabOf("home", AppMode.SELLING))
    }

    // SP-0195: a link, notification or mode change to a page of a hidden tab lands on that mode's Home.
    @Test fun hiddenTabPagesOpenTheModesHome() {
        assertEquals("home", FieldNav.pageForMode("route", AppMode.MAPPING))
        assertEquals("home", FieldNav.pageForMode("sell", AppMode.MAPPING))
        assertEquals("home", FieldNav.pageForMode("sell", AppMode.VISITS))
        assertEquals("home", FieldNav.pageForMode("route", AppMode.SELLING))
        assertEquals("route", FieldNav.pageForMode("route", AppMode.VISITS))
        assertEquals("sell", FieldNav.pageForMode("sell", AppMode.SELLING))
        for (mode in AppMode.entries) for (page in listOf("home", "customers", "customer", "messages", "more", "account", "sync",
            "census", "catalogue", "support")) assertEquals("$mode $page", page, FieldNav.pageForMode(page, mode))
    }

    @Test fun everyPageKeepsAParentTab() {
        assertEquals(FieldTab.TODAY, FieldNav.tabOf("home"))
        assertEquals(FieldTab.ROUTE, FieldNav.tabOf("route"))
        assertEquals(FieldTab.STORES, FieldNav.tabOf("customer"))
        assertEquals(FieldTab.MESSAGES, FieldNav.tabOf("messages"))
        for (page in listOf("account", "sync", "support", "catalogue", "census", "team", "workforce", "jointcall", "collections",
            "incentives", "change-password", "location-battery")) assertEquals(page, FieldTab.MORE, FieldNav.tabOf(page))
    }

    @Test fun barShowsOnTabsAndLightDrillDownsButNotInFlows() {
        fun bar(page: String, visit: Boolean = false, partner: Boolean = false, ready: Boolean = true, locked: Boolean = false) =
            FieldNav.barVisible(ready, locked, partner, visit, page)
        for (page in listOf("home", "route", "customers", "customer", "messages", "more", "account", "sync", "support", "catalogue", "team"))
            assertTrue(page, bar(page))
        for (page in listOf("change-password", "census", "workforce", "jointcall", "collections", "location-consent", "location-background",
            "location-battery")) assertFalse(page, bar(page))
        assertFalse("inside a visit", bar("home", visit = true))
        assertFalse("partner mode", bar("home", partner = true))
        assertFalse("before sign-in", bar("home", ready = false))
        assertFalse("while locked", bar("home", locked = true))
    }

    @Test fun backReturnsToThePageADrillDownOpenedFrom() {
        for (page in listOf("account", "sync", "team", "catalogue", "census", "workforce", "jointcall", "collections", "incentives",
            "location-battery")) {
            assertEquals(page, BackStep.ToPage("more"), BackNavigation.step(BackState(page = page, origin = "more")))
            assertEquals(page, BackStep.ToPage("route"), BackNavigation.step(BackState(page = page, origin = "route")))
        }
        assertEquals(BackStep.ToPage("home"), BackNavigation.step(BackState(page = "more")))
        assertEquals(BackStep.ToPage("account"), BackNavigation.step(BackState(page = "support", origin = "more")))
    }
}
