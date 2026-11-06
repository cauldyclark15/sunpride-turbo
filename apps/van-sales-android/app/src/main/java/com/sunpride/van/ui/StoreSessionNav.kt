package com.sunpride.van.ui

/**
 * IP-P0 (SPEC 7.1): the cashier-session screens, as a pure reducer.
 *
 * Open and close are two different pages with a fixed purpose each. Nothing here is derived from "is a session open"
 * to pick a mode: the open page can only be reached when no session is open, and the cash-count page can only be
 * reached through the End-session confirmation (which shows the X reading first).
 */
data class StoreNav(val page: Page = Page.HOME, val endSheet: Boolean = false, val countUnlocked: Boolean = false)

sealed interface StoreNavEvent {
    /** "Open cashier session" tapped on Store home. */
    data object OpenTapped : StoreNavEvent
    /** The opening float was saved on the phone. */
    data object OpenSaved : StoreNavEvent
    /** "End session" tapped (secondary row on Store home): shows the confirmation sheet, never the count. */
    data object EndTapped : StoreNavEvent
    /** "Continue to cash count" tapped inside the confirmation sheet. */
    data object EndConfirmed : StoreNavEvent
    data object EndCancelled : StoreNavEvent
    /** The blind count was saved and the session is closed. */
    data object CloseSaved : StoreNavEvent
    /** Back from the open or count page. */
    data object Back : StoreNavEvent
}

object StoreSessionNav {
    private val HOME = StoreNav()

    fun reduce(state: StoreNav, event: StoreNavEvent, shiftOpen: Boolean): StoreNav = when (event) {
        StoreNavEvent.OpenTapped -> if (shiftOpen) HOME else StoreNav(Page.STORE_OPEN)
        // After a successful open the cashier lands on Store home, never on a count.
        StoreNavEvent.OpenSaved -> HOME
        StoreNavEvent.EndTapped -> if (shiftOpen) StoreNav(Page.HOME,endSheet = true) else HOME
        StoreNavEvent.EndConfirmed ->
            if (shiftOpen && state.endSheet) StoreNav(Page.STORE_CLOSE,countUnlocked = true) else guard(state,shiftOpen)
        StoreNavEvent.EndCancelled -> state.copy(endSheet = false)
        StoreNavEvent.CloseSaved -> HOME
        StoreNavEvent.Back -> HOME
    }

    /** What may actually be drawn: a stale state can never show the count or the open form in the wrong situation. */
    fun guard(state: StoreNav, shiftOpen: Boolean): StoreNav = when {
        state.page == Page.STORE_CLOSE && !(state.countUnlocked && shiftOpen) -> HOME
        state.page == Page.STORE_OPEN && shiftOpen -> HOME
        state.endSheet && !shiftOpen -> state.copy(endSheet = false)
        else -> state
    }

    /** Whether the cash-count page may be opened by a generic `open(page)` call: only through the confirmation. */
    fun mayOpen(page: Page, state: StoreNav, shiftOpen: Boolean): Boolean = when (page) {
        Page.STORE_CLOSE -> state.countUnlocked && shiftOpen
        Page.STORE_OPEN -> !shiftOpen
        else -> true
    }
}

/** Why "New sale" is disabled on Store home, in plain words; null when it can be used. */
object StoreNewSale {
    fun blockedReason(shiftOpen: Boolean, onHold: Boolean, transactionsEnabled: Boolean, hasProducts: Boolean): String? = when {
        !shiftOpen -> "Open a cashier session first"
        onHold -> "Sync to confirm this handheld with the office"
        !hasProducts -> "Sync to download prices"
        !transactionsEnabled -> "Selling is not switched on for this register yet. Tap Sync now, or ask the office."
        else -> null
    }
}
