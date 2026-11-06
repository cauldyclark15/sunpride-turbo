package com.sunpride.van.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** One bottom-bar destination: where its tab lands ([root]) and which tab id a page belongs to ([AppNav.tabOf]). */
data class NavDest(val id: String, val label: String, val glyph: GlyphKind, val root: Page)

/**
 * POS v2: the bottom bar for both modes, as plain data so it is unit-tested. Five destinations per mode; every page belongs to exactly one tab
 * (so the right tab lights up on a deep screen) or to none (the Payment/Complete flow, where the bar hides).
 */
object AppNav {
    val STORE = listOf(
        NavDest("sell", "Sell", GlyphKind.CART, Page.STORE_SALE),
        NavDest("sales", "Sales", GlyphKind.RECEIPT, Page.STORE_RECEIPTS),
        NavDest("till", "Till", GlyphKind.WALLET, Page.HOME),
        NavDest("stock", "Stock", GlyphKind.BOX, Page.STORE_STOCK),
        NavDest("more", "More", GlyphKind.DOTS, Page.MORE))
    val VAN = listOf(
        NavDest("today", "Today", GlyphKind.HOME, Page.HOME),
        NavDest("sell", "Sell", GlyphKind.CART, Page.CUSTOMERS),
        NavDest("stock", "Stock", GlyphKind.BOX, Page.STOCK),
        NavDest("receipts", "Receipts", GlyphKind.RECEIPT, Page.RECEIPTS),
        NavDest("more", "More", GlyphKind.DOTS, Page.MORE))

    fun tabs(store: Boolean): List<NavDest> = if (store) STORE else VAN

    /** Pages that are a step of a sale being finished: no bar there (it would offer a way out in the middle of taking money). */
    val FLOW_PAGES = setOf(Page.CHECKOUT, Page.SALE_DONE)

    /** The tab id a page belongs to, or null when the bar is hidden on it. */
    fun tabOf(page: Page, store: Boolean): String? = if (store) when (page) {
        Page.STORE_SALE -> "sell"
        Page.STORE_RECEIPTS -> "sales"
        // Opening and counting the drawer are focused cash steps: no bar, just Back.
        Page.STORE_OPEN, Page.STORE_CLOSE -> null
        Page.HOME, Page.STORE_READS, Page.STORE_DEPOSIT -> "till"
        Page.STORE_STOCK -> "stock"
        Page.MORE, Page.SYNC, Page.PRINTER, Page.POS_MODE, Page.ACCOUNT, Page.CHANGE_PASSWORD, Page.STORE_CUSTOMERS, Page.LOCATION_CONSENT -> "more"
        // Van-only pages cannot be on screen in store mode; if one is, Till is the safe home.
        else -> "till"
    } else when (page) {
        Page.HOME, Page.START, Page.CASH, Page.CLOSE_TRIP, Page.LOCATION_CONSENT, Page.ACCEPT_LOAD, Page.LOAD, Page.STOCK_COUNT, Page.ROUTE_OPS -> "today"
        Page.CUSTOMERS, Page.WALK_IN, Page.CUSTOMER, Page.SALE, Page.RETURN, Page.RETURN_DONE -> "sell"
        Page.STOCK, Page.PRODUCTS, Page.CATALOGUE -> "stock"
        Page.RECEIPTS -> "receipts"
        Page.MORE, Page.SYNC, Page.PRINTER, Page.POS_MODE, Page.ACCOUNT, Page.CHANGE_PASSWORD -> "more"
        Page.CHECKOUT, Page.SALE_DONE -> null
        // Store-only pages cannot be on screen in van mode; if one is, Today is the safe home.
        else -> "today"
    }

    /** [flowHidden] is set by a host whose Payment/Complete steps share a page with the grid (the store sale). */
    fun barVisible(page: Page, store: Boolean, flowHidden: Boolean = false): Boolean = !flowHidden && tabOf(page, store) != null
}

/** True while the bottom bar is drawn below the screen (selling lists need no extra room above the system bar then). */
val LocalNavBarShown = compositionLocalOf { false }

/** The small sync badge: "Synced", "3 waiting", "2 to review". It never covers content; it sits in the title bar. */
@Composable fun SyncPill(waiting: Int, review: Int, busy: Boolean, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val (text, dot) = when {
        review > 0 -> "$review to review" to Look.amberDot
        busy -> "Syncing…" to Look.amberDot
        waiting > 0 -> "$waiting waiting" to Look.amberDot
        else -> "All sent" to SunprideTokens.stockGreen
    }
    Box(modifier.heightIn(min = 48.dp).then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier).testTag("sync-pill"), contentAlignment = Alignment.Center) {
        Row(Modifier.clip(CircleShape).background(Color.White).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(dot))
            Text(text, color = Color(0xFF18181B), fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
        }
    }
}

/** The pill wired to the controller; tapping it opens the full Sync & posting screen. */
@Composable fun SyncPill(c: VanController, modifier: Modifier = Modifier) = SyncPill(c.syncWaiting, c.syncReview, c.busy, modifier) { c.open(Page.SYNC) }

/**
 * The bottom bar: Material 3 [NavigationBarItem]s with a sync badge on More, in a 64dp container. The stock NavigationBar is 80dp tall,
 * a fifth of a 720x1440 handheld, and the product grid needs that room; the items, indicator and semantics are the Material ones.
 */
@Composable fun AppNavBar(c: VanController, modifier: Modifier = Modifier) {
    val store = c.storeMode
    val tabs = AppNav.tabs(store)
    val current = AppNav.tabOf(c.page, store)
    val needs = c.syncReview > 0
    val waiting = c.syncWaiting
    Column(modifier.testTag("nav-bar")) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(Look.hairline))
        Surface(color = Look.sheet) { Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).height(64.dp).selectableGroup()) {
            tabs.forEach { d ->
                val on = d.id == current
                NavigationBarItem(
                    selected = on, onClick = { selectTab(c, d) }, alwaysShowLabel = true,
                    modifier = Modifier.testTag("nav-${d.id}"),
                    icon = {
                        val badge = d.id == "more" && (needs || waiting > 0)
                        BadgedBox(badge = {
                            if (badge) Badge(containerColor = if (needs) SunprideTokens.emptyRed else Look.amberDot, contentColor = Color.White, modifier = Modifier.testTag("nav-more-badge")) {
                                Text(if (needs) "!" else if (waiting > 9) "9+" else "$waiting", fontSize = 11.sp, fontWeight = FontWeight.Bold)
                            }
                        }) { Glyph(d.glyph, LocalContentColor.current, 26.dp) }
                    },
                    label = { Text(d.label, fontSize = 13.sp, lineHeight = 16.sp, fontWeight = if (on) FontWeight.ExtraBold else FontWeight.SemiBold, maxLines = 1) },
                    colors = NavigationBarItemDefaults.colors(selectedIconColor = Look.accent, selectedTextColor = Look.accent, indicatorColor = Look.tint,
                        unselectedIconColor = Look.muted, unselectedTextColor = Look.muted))
            }
        } }
    }
}

/** A tab always lands on its own root; the van Sell tab goes back into a sale that is in progress. */
private fun selectTab(c: VanController, d: NavDest) {
    if (c.page == d.root) return
    if (!c.storeMode && d.id == "sell" && c.sale != null) { if (c.page != Page.SALE) c.continueSale(); return }
    c.open(d.root)
}

/** Wraps the signed-in screens: content above, the bar below it (hidden in the sale flow and while the keyboard is up). */
@OptIn(ExperimentalLayoutApi::class)
@Composable fun AppShell(c: VanController, content: @Composable () -> Unit) {
    val imeUp = WindowInsets.isImeVisible
    val show = AppNav.barVisible(c.page, c.storeMode, c.navHidden) && !imeUp
    Column(Modifier.fillMaxSize().background(Look.canvas)) {
        Box(Modifier.weight(1f).fillMaxWidth().then(if (show) Modifier.consumeWindowInsets(WindowInsets.navigationBars) else Modifier)) {
            CompositionLocalProvider(LocalNavBarShown provides show) { content() }
        }
        if (show) AppNavBar(c)
    }
}

/** An empty list that says what to do next, instead of "nothing here". */
@Composable fun EmptyState(glyph: GlyphKind, title: String, body: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null, actionTag: String = "empty-action") {
    Column(modifier.fillMaxWidth().padding(vertical = 24.dp, horizontal = 8.dp).testTag("empty-state"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(72.dp).clip(CircleShape).background(Look.tint), contentAlignment = Alignment.Center) { Glyph(glyph, Look.accent, 34.dp) }
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyLarge, color = Look.muted, textAlign = TextAlign.Center)
        if (actionLabel != null && onAction != null) PillButton(actionLabel, onAction, Modifier.padding(top = 6.dp).testTag(actionTag))
    }
}

/** Store Sell tab before a cashier session is open: one clear next step instead of a grid that cannot be used. */
@Composable fun StoreSellLocked(c: VanController) {
    ScreenFrame("Sell", trailing = { SyncPill(c) }) {
        EmptyState(GlyphKind.WALLET, "Open the till to start selling", "Count the cash in the drawer, then you can scan and sell.",
            Modifier.padding(top = 32.dp), actionLabel = if (c.onHold) null else "Open the till", onAction = { c.beginOpenSession() }, actionTag = "store-open-session")
        if (c.onHold) Text("This register is paused until the office confirms it. Tap Sync on the More tab.", style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth())
    }
}

/** Everything that is not a daily job, in one place: sync, printer, settings, account, sign out. Same list in Store and Van mode. */
@Composable fun MoreScreen(c: VanController) {
    val store = c.storeMode
    val last = c.sync.lastSyncTime?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d, h:mm a")) } ?: "Not yet"
    val context = LocalContext.current
    ScreenFrame("More", message = c.message, trailing = { SyncPill(c) }) {
        Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(Look.cardRadius), color = Look.card, border = androidx.compose.foundation.BorderStroke(1.dp, Look.hairline)) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(c.seller?.name ?: "Sunpride", size = 52.dp)
                Column(Modifier.weight(1f)) {
                    Text(c.seller?.name ?: "Signed in", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(if (store) "Cashier · ${c.storePos.config?.storeName ?: "Store"}" else "Van seller" + (c.trip?.vehicle?.let { " · Truck ${it.vehicleCode}" } ?: ""),
                        style = MaterialTheme.typography.bodyMedium, color = Look.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        ListRow("Sync now", if (c.sync.lastSyncTime == null) "Send saved work and check for changes" else "Last synced: $last", if (store) "store-sync" else "sync-now", enabled = !c.busy, onClick = c::syncNow, glyph = GlyphKind.SYNC)
        ListRow("Sync & posting", "What is on this phone, with the office and in SAP", "open-sync", onClick = { c.open(Page.SYNC) }, glyph = GlyphKind.RECEIPT)
        ListRow("Printer & scanner", "Check the printer and paper", if (store) "store-printer" else "open-printer", onClick = { c.open(Page.PRINTER) }, glyph = GlyphKind.PRINTER)
        if (store) ListRow("Customers & points", "Phone lookup · optional loyalty", "store-customers", onClick = { c.open(Page.STORE_CUSTOMERS) }, glyph = GlyphKind.USERS)
        if (!store && !c.fixtureMode) com.sunpride.van.chat.VanMessagesEntry() // SP-0146 v2 messaging (not in practice-data mode)
        c.features.reportIssueUrl?.let { url -> ListRow("Report an issue", "Tell the Sunpride team what went wrong", "report-issue", onClick = { openLink(context, url) }, glyph = GlyphKind.FLAG) }
        ListRow("POS mode", if (store) "Now: Store · set by the office" else "Now: Van · set by the office", "open-pos-mode", onClick = { c.open(Page.POS_MODE) }, glyph = GlyphKind.SWITCH)
        ListRow("Account", "Password and sign out", "open-account", onClick = { c.open(Page.ACCOUNT) }, glyph = GlyphKind.USER)
        SecondaryButton("Sign out", c::signOut, Modifier.testTag("sign-out"), !c.busy)
        Text("Sunpride ${if (store) "Store POS" else "Van"} · ${com.sunpride.van.BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.bodyMedium, color = Look.muted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().testTag("app-version"))
    }
}
