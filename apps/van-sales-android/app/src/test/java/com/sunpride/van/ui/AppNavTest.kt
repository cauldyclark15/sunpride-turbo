package com.sunpride.van.ui

import org.junit.Assert.*
import org.junit.Test

/** POS v2: the bottom bar. Five destinations per mode, every page under one tab, the bar hidden only where money is being taken. */
class AppNavTest {
    private val storePages = setOf(Page.HOME, Page.STORE_SALE, Page.STORE_READS, Page.STORE_RECEIPTS, Page.STORE_STOCK, Page.STORE_DEPOSIT, Page.STORE_CUSTOMERS,
        Page.STORE_OPEN, Page.STORE_CLOSE, Page.POS_MODE, Page.ACCOUNT, Page.CHANGE_PASSWORD, Page.PRINTER, Page.SYNC, Page.MORE)

    @Test fun eachModeHasFiveDestinationsWithDistinctIdsAndRoots() {
        listOf(true, false).forEach { store ->
            val tabs = AppNav.tabs(store)
            assertEquals(5, tabs.size)
            assertEquals(5, tabs.map { it.id }.toSet().size)
            assertEquals(5, tabs.map { it.root }.toSet().size)
            assertEquals("More is always last", "more", tabs.last().id)
        }
        assertEquals(listOf("sell", "sales", "till", "stock", "more"), AppNav.tabs(true).map { it.id })
        assertEquals(listOf("today", "sell", "stock", "receipts", "more"), AppNav.tabs(false).map { it.id })
    }

    @Test fun everyTabRootShowsTheBarWithItsOwnTabSelected() {
        listOf(true, false).forEach { store ->
            AppNav.tabs(store).forEach { d ->
                assertEquals("${d.id} root selects itself (store=$store)", d.id, AppNav.tabOf(d.root, store))
                assertTrue(AppNav.barVisible(d.root, store))
            }
        }
    }

    @Test fun everyVanPageIsUnderATabOrIsPartOfTheSaleFlow() {
        val hidden = Page.entries.filter { AppNav.tabOf(it, false) == null }.toSet()
        assertEquals(setOf(Page.CHECKOUT, Page.SALE_DONE), hidden)
        val tabs = AppNav.tabs(false).map { it.id }.toSet()
        Page.entries.filter { it !in hidden }.forEach { assertTrue("$it -> ${AppNav.tabOf(it, false)}", AppNav.tabOf(it, false) in tabs) }
    }

    @Test fun everyStorePageIsUnderATabExceptTheFocusedCashSteps() {
        val hidden = storePages.filter { AppNav.tabOf(it, true) == null }.toSet()
        assertEquals("opening and counting the drawer are focused steps with their own Back", setOf(Page.STORE_OPEN, Page.STORE_CLOSE), hidden)
        val tabs = AppNav.tabs(true).map { it.id }.toSet()
        storePages.filter { it !in hidden }.forEach { assertTrue("$it -> ${AppNav.tabOf(it, true)}", AppNav.tabOf(it, true) in tabs) }
    }

    @Test fun theBarHidesWhileMoneyIsBeingTaken() {
        assertFalse(AppNav.barVisible(Page.CHECKOUT, false))
        assertFalse(AppNav.barVisible(Page.SALE_DONE, false))
        // The store sale shares one page between the grid and Payment/Complete; the host raises the flag for those steps.
        assertTrue(AppNav.barVisible(Page.STORE_SALE, true, flowHidden = false))
        assertFalse(AppNav.barVisible(Page.STORE_SALE, true, flowHidden = true))
        assertTrue("the van sale grid keeps the bar", AppNav.barVisible(Page.SALE, false))
    }

    @Test fun nothingThatWasReachableBeforeIsLeftWithoutAHome() {
        // Store: the old Home menu rows -> where they live now.
        assertEquals("till", AppNav.tabOf(Page.STORE_READS, true))      // X / Z & cash
        assertEquals("till", AppNav.tabOf(Page.STORE_DEPOSIT, true))    // Cash deposit
        assertEquals("sales", AppNav.tabOf(Page.STORE_RECEIPTS, true))  // Receipts, voids & refunds
        assertEquals("stock", AppNav.tabOf(Page.STORE_STOCK, true))     // Receiving & counts
        assertEquals("more", AppNav.tabOf(Page.STORE_CUSTOMERS, true))  // Customers & points
        listOf(Page.SYNC, Page.PRINTER, Page.POS_MODE, Page.ACCOUNT).forEach { assertEquals("more", AppNav.tabOf(it, true)); assertEquals("more", AppNav.tabOf(it, false)) }
        // Van: Today, Customers/Sale, Stock, Receipts, More.
        assertEquals("sell", AppNav.tabOf(Page.CUSTOMERS, false)); assertEquals("sell", AppNav.tabOf(Page.SALE, false)); assertEquals("sell", AppNav.tabOf(Page.RETURN, false))
        assertEquals("stock", AppNav.tabOf(Page.PRODUCTS, false)); assertEquals("stock", AppNav.tabOf(Page.CATALOGUE, false))
        listOf(Page.ACCEPT_LOAD, Page.LOAD, Page.START, Page.CASH, Page.STOCK_COUNT, Page.CLOSE_TRIP, Page.ROUTE_OPS).forEach { assertEquals("today", AppNav.tabOf(it, false)) }
        assertEquals("receipts", AppNav.tabOf(Page.RECEIPTS, false))
    }
}
