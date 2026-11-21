package com.sunpride.field.ui

import androidx.compose.ui.unit.Density
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.Badge
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/**
 * The places a person works from. Every screen of the app belongs to one of them. SP-0195: the bar shows only the tabs
 * of the person's App mode ([FieldNav.tabs]), never more than four. [MESSAGES] is never on the bar: Messages opens from
 * the envelope in the top bar; the entry stays so the Messages page still has a home.
 */
enum class FieldTab(val page: String, val label: String, val glyph: GlyphKind, val tag: String) {
    HOME("home", "Home", GlyphKind.TODAY, "nav-home"),
    TODAY("home", "Today", GlyphKind.TODAY, "nav-today"),
    SELL("sell", "Sell", GlyphKind.CASH, "nav-sell"),
    ROUTE("route", "Route", GlyphKind.ROUTE, "nav-route"),
    STORES("customers", "Customers", GlyphKind.STORE, "nav-stores"),
    MESSAGES("messages", "Messages", GlyphKind.CHAT, "nav-messages"),
    MORE("more", "More", GlyphKind.MORE, "nav-more"),
}

object FieldNav {
    /** SP-0195: the most tabs any mode shows; labels stay at their normal size. */
    const val MAX_TABS = 4
    /** SP-0195: the bar's places for each App mode (Customer mapping, Field visits, Truck selling). */
    fun tabs(mode: AppMode): List<FieldTab> = when (mode) {
        AppMode.MAPPING -> listOf(FieldTab.HOME, FieldTab.STORES, FieldTab.MORE)
        AppMode.VISITS -> listOf(FieldTab.TODAY, FieldTab.ROUTE, FieldTab.STORES, FieldTab.MORE)
        AppMode.SELLING -> listOf(FieldTab.TODAY, FieldTab.SELL, FieldTab.STORES, FieldTab.MORE)
    }
    /** Largest text scale the bottom bar's labels use; four labels fit side by side on a 360 dp phone. */
    const val MAX_BAR_LABEL_SCALE = 1.0f
    fun barLabelFontScale(system: Float): Float = minOf(system, MAX_BAR_LABEL_SCALE)
    /** Pages that are the root of a tab: no Back arrow, system Back returns to Today. */
    val tabRoots: Set<String> = FieldTab.entries.map { it.page }.toSet()

    /** Pages that are forms or one-time steps: the bar steps aside so it cannot pull the seller out mid-entry. */
    val noBarPages: Set<String> = setOf("change-password", "location-consent", "location-battery",
        "census", "workforce", "jointcall", "collections", "remit")

    /** Pages reached from somewhere else (Account, Sync, a tool): Back returns to the page they opened from. */
    val overlayPages: Set<String> = setOf("account", "sync", "support", "change-password", "incentives", "catalogue", "census",
        "team", "workforce", "jointcall", "collections", "remit", "location-consent", "location-battery")

    /** Pages FieldApp shows even while a visit is open (they come before the visit screens in its `when`). */
    val pagesAheadOfVisit: Set<String> = setOf("account", "incentives", "change-password", "support", "location-consent",
        "location-battery", "collections", "remit", "jointcall", "catalogue", "census", "workforce", "messages",
        "sync", "more")

    /** The tab a page belongs to (drill-down pages keep their parent tab selected). */
    fun tabOf(page: String, mode: AppMode = AppMode.VISITS): FieldTab = when (page) {
        "home" -> if (mode == AppMode.MAPPING) FieldTab.HOME else FieldTab.TODAY
        "sell" -> FieldTab.SELL
        "route" -> FieldTab.ROUTE
        "customers", "customer" -> FieldTab.STORES
        "messages" -> FieldTab.MESSAGES
        else -> FieldTab.MORE
    }

    /**
     * SP-0195: a page whose tab this mode hides (a link, a notification, or the office just changed the mode) opens the
     * mode's Home instead. Messages and everything under More stay reachable in every mode.
     */
    fun pageForMode(page: String, mode: AppMode): String {
        if (mode == AppMode.MAPPING && page in mappingHiddenPages) return "home"
        val tab = tabOf(page, mode)
        return if (tab == FieldTab.MORE || tab == FieldTab.MESSAGES || tab in tabs(mode)) page else "home"
    }

    /** SP-0195: More pages Customer mapping hides (Attendance, Collections, Earned statements, Work-With, Your team). */
    val mappingHiddenPages: Set<String> = setOf("workforce", "collections", "remit", "incentives", "jointcall", "team")

    /**
     * The "Your work" rows More shows, in order. Customer mapping keeps only Products and Add customer; Field visits and
     * Truck selling are unchanged (Add customer needs Visits, Work-With a supervisor, Your team the Team feature too).
     */
    fun moreWorkRows(mode: AppMode, visits: Boolean, supervisor: Boolean, team: Boolean, remit: Boolean = false): List<MoreRow> =
        if (mode == AppMode.MAPPING) listOf(MoreRow.PRODUCTS, MoreRow.ADD_CUSTOMER)
        else listOfNotNull(MoreRow.PRODUCTS, MoreRow.ADD_CUSTOMER.takeIf { visits }, MoreRow.ATTENDANCE, MoreRow.COLLECTIONS,
            MoreRow.REMIT_CASH.takeIf { remit }, MoreRow.WORK_WITH.takeIf { supervisor }, MoreRow.TEAM.takeIf { team && supervisor }, MoreRow.EARNED_STATEMENTS)

    /**
     * E2E-001: the moment the app becomes ready (sign-in or registration just finished, or a launch) it opens on
     * Today, never on a tab left over from before (Customers). A notification tap that targets a page keeps it.
     */
    fun pageOnReady(wasReady: Boolean, ready: Boolean, page: String, targeted: Boolean = false): String =
        if (!wasReady && ready && !targeted) "home" else page

    /** Pages a phone that is not ready yet (Register phone, Phone removed) can still open. */
    val waitingPages: Set<String> = setOf("account", "support", "change-password")
    /**
     * E2E-001 (Register → Check again): while the Register phone screen shows, the page behind it goes back to
     * Today. A tab left over from before (Customers) otherwise survived registration and was what opened on
     * Check again, whatever the ready transition did.
     */
    fun pageWhileWaiting(page: String): String = if (page in waitingPages) page else "home"

    fun barVisible(ready: Boolean, locked: Boolean, partnerMode: Boolean, visitOpen: Boolean, page: String): Boolean =
        ready && !locked && !partnerMode && !visitOpen && page !in noBarPages
}

/**
 * Material 3 navigation bar: the mode's three or four labelled places. The selected one gets the pale red pill and red
 * icon. White like the sheet, with a hairline on top, so it reads as part of the page.
 */
@Composable
fun FieldBottomBar(selected: FieldTab, onSelect: (FieldTab) -> Unit, modifier: Modifier = Modifier,
    tabs: List<FieldTab> = FieldNav.tabs(AppMode.VISITS)) {
    val line = Look.hairline
    NavigationBar(modifier.drawBehind { drawLine(line, Offset(0f, 0f), Offset(size.width, 0f), strokeWidth = 1.dp.toPx()) },
        containerColor = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
        tabs.take(FieldNav.MAX_TABS).forEach { tab ->
            val on = tab == selected
            NavigationBarItem(selected = on, onClick = { onSelect(tab) },
                modifier = Modifier.testTag(tab.tag),
                icon = { Glyph(tab.glyph, if (on) Look.onTint else Look.muted, 24.dp) },
                label = {
                    // FLD-173: at the phone's largest font the labels would clip; the bar caps its own label scale
                    // so every label stays whole and readable.
                    val density = LocalDensity.current
                    CompositionLocalProvider(LocalDensity provides Density(density.density,
                        FieldNav.barLabelFontScale(density.fontScale))) {
                        Text(tab.label, style = MaterialTheme.typography.labelMedium, maxLines = 1, softWrap = false)
                    }
                },
                alwaysShowLabel = true,
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = Look.onTint, selectedTextColor = MaterialTheme.colorScheme.onSurface,
                    indicatorColor = Look.tint, unselectedIconColor = Look.muted, unselectedTextColor = Look.muted))
        }
    }
}

/**
 * SP-0195: Messages in the red top bar, next to Account: the envelope with the unread count on it. Opens the Messages page.
 */
@Composable
fun HeaderMessagesButton(unread: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val description = if (unread > 0) "Messages, $unread unread" else "Messages"
    Box(modifier) {
        HeaderRoundButton(GlyphKind.CHAT, description, onClick, Modifier.testTag("messages-open"))
        if (unread > 0) Badge(containerColor = androidx.compose.ui.graphics.Color.White, contentColor = Look.accent,
            modifier = Modifier.align(androidx.compose.ui.Alignment.TopEnd).padding(top = 2.dp, end = 2.dp)
                .testTag("messages-badge")) {
            Text(if (unread > 99) "99+" else "$unread", style = MaterialTheme.typography.labelSmall)
        }
    }
}

/** True while the on-screen keyboard is up: the bar hides so a form keeps its room. */
@Composable
fun rememberImeVisible(): Boolean {
    val density = LocalDensity.current
    return WindowInsets.ime.getBottom(density) > 0
}

/** SP-0195: the rows of More's "Your work" group. */
enum class MoreRow { PRODUCTS, ADD_CUSTOMER, ATTENDANCE, COLLECTIONS, REMIT_CASH, WORK_WITH, TEAM, EARNED_STATEMENTS }
