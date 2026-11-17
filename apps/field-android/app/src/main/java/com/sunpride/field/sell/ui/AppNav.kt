package com.sunpride.field.sell.ui

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

/** One Sell-area destination: where its tab lands ([root]) and which tab id a page belongs to ([AppNav.tabOf]). */
data class NavDest(val id: String, val label: String, val glyph: GlyphKind, val root: Page)

/**
 * SP-0192: the Sell area's own places, as plain data so it is unit-tested. The Field app's bottom bar has ONE Sell tab;
 * inside it these five sit in a row just above that bar (the Van app's Today/Sell/Stock/Receipts/More; Today is "Trip" here).
 * Every page belongs to exactly one of them, or to none (Payment/Complete: the row and the Field bar both step aside).
 */
object AppNav {
    val VAN = listOf(
        NavDest("today", "Trip", GlyphKind.HOME, Page.HOME),
        NavDest("sell", "Sell", GlyphKind.CART, Page.CUSTOMERS),
        NavDest("stock", "Stock", GlyphKind.BOX, Page.STOCK),
        NavDest("receipts", "Receipts", GlyphKind.RECEIPT, Page.RECEIPTS),
        NavDest("more", "More", GlyphKind.DOTS, Page.MORE))

    /** Pages that are a step of a sale being finished: no bar there (it would offer a way out in the middle of taking money). */
    val FLOW_PAGES = setOf(Page.CHECKOUT, Page.SALE_DONE)

    /** The tab id a page belongs to, or null when the bars are hidden on it. */
    fun tabOf(page: Page): String? = when (page) {
        Page.HOME, Page.START, Page.CASH, Page.CLOSE_TRIP, Page.LOCATION_CONSENT, Page.ACCEPT_LOAD, Page.LOAD, Page.STOCK_COUNT, Page.ROUTE_OPS -> "today"
        Page.CUSTOMERS, Page.WALK_IN, Page.CUSTOMER, Page.SALE, Page.RETURN, Page.RETURN_DONE -> "sell"
        Page.STOCK, Page.PRODUCTS, Page.CATALOGUE -> "stock"
        Page.RECEIPTS -> "receipts"
        Page.MORE, Page.SYNC, Page.PRINTER -> "more"
        Page.CHECKOUT, Page.SALE_DONE -> null
    }

    /** [flowHidden] is set by a selling host that hides the bars itself (Payment and Complete). */
    fun barVisible(page: Page, flowHidden: Boolean = false): Boolean = !flowHidden && tabOf(page) != null
}

/** True while the bottom bar is drawn below the screen (selling lists need no extra room above the system bar then). */
val LocalNavBarShown = compositionLocalOf { false }

/** SP-0192: whether the phone has no signal now (the Field app's own reading), for the Sell area's sync badge. */
val LocalSellOffline = compositionLocalOf { false }

/** The badge's words: the Field app's simple-sync rule (SP-0189): only "All sent", "Waiting to send (N)" or "Waiting for signal". */
object SellSyncWords {
    fun label(waiting: Int, offline: Boolean): String = when {
        waiting > 0 && offline -> com.sunpride.field.ui.syncstatus.SyncStatus.WAITING_FOR_SIGNAL
        waiting > 0 -> com.sunpride.field.ui.syncstatus.SyncStatus.waitingToSend(waiting)
        else -> com.sunpride.field.ui.syncstatus.SyncStatus.ALL_SENT
    }
}

/** The small sync badge (never a review count, SP-0190). It never covers content; it sits in the title bar. */
@Composable fun SyncPill(waiting: Int, review: Int, busy: Boolean, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val text = SellSyncWords.label(waiting, LocalSellOffline.current)
    val dot = if (waiting > 0 || busy) Look.amberDot else SunprideTokens.stockGreen
    Box(modifier.heightIn(min = 48.dp).then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier).testTag("sync-pill"), contentAlignment = Alignment.Center) {
        Row(Modifier.clip(CircleShape).background(Color.White).padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(9.dp).clip(CircleShape).background(dot))
            Text(text, color = Color(0xFF18181B), fontSize = 13.sp, fontWeight = FontWeight.Bold, maxLines = 1, softWrap = false)
        }
    }
}

/** The pill wired to the controller; tapping it opens the full Sync & posting screen. */
@Composable fun SyncPill(c: VanController, modifier: Modifier = Modifier) = SyncPill(c.syncWaiting, c.syncReview, c.busy, modifier) { c.open(Page.SYNC) }

/** An empty list that says what to do next, instead of "nothing here". */
@Composable fun EmptyState(glyph: GlyphKind, title: String, body: String, modifier: Modifier = Modifier, actionLabel: String? = null, onAction: (() -> Unit)? = null, actionTag: String = "empty-action") {
    Column(modifier.fillMaxWidth().padding(vertical = 24.dp, horizontal = 8.dp).testTag("empty-state"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(72.dp).clip(CircleShape).background(Look.tint), contentAlignment = Alignment.Center) { Glyph(glyph, Look.accent, 34.dp) }
        Text(title, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
        Text(body, style = MaterialTheme.typography.bodyLarge, color = Look.muted, textAlign = TextAlign.Center)
        if (actionLabel != null && onAction != null) PillButton(actionLabel, onAction, Modifier.padding(top = 6.dp).testTag(actionTag))
    }
}


/** SP-0192: the Sell area's five places in one row above the Field bar; the selected one is filled. Hidden in the sale flow. */
@Composable fun SellTabRow(c: VanController, modifier: Modifier = Modifier) {
    val current = AppNav.tabOf(c.page)
    Row(modifier.fillMaxWidth().background(Look.sheet).padding(horizontal = 8.dp, vertical = 6.dp).selectableGroup().testTag("sell-tabs"),
        horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        AppNav.VAN.forEach { d ->
            val on = d.id == current
            Box(Modifier.weight(1f).heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).background(if (on) Look.ink else Color.Transparent)
                .clickable(role = Role.Tab) { selectTab(c, d) }.semantics { contentDescription = d.label }.testTag("sell-tab-${d.id}"),
                contentAlignment = Alignment.Center) {
                val badge = d.id == "more" && c.syncWaiting > 0
                Text(if (badge) "${d.label} •" else d.label, color = if (on) Color.White else Look.muted, fontSize = 13.sp,
                    fontWeight = if (on) FontWeight.ExtraBold else FontWeight.SemiBold, maxLines = 1, softWrap = false)
            }
        }
    }
}

/** A tab always lands on its own root; Sell goes back into a sale that is in progress. */
private fun selectTab(c: VanController, d: NavDest) {
    if (c.page == d.root) return
    if (d.id == "sell" && c.sale != null) { if (c.page != Page.SALE) c.continueSale(); return }
    c.open(d.root)
}

/** The Sell area inside the Field app: its tab row above, the Van screens below. */
@OptIn(ExperimentalLayoutApi::class)
@Composable fun SellShell(c: VanController, content: @Composable () -> Unit) {
    val imeUp = WindowInsets.isImeVisible
    val show = AppNav.barVisible(c.page, c.navHidden) && !imeUp
    Column(Modifier.fillMaxSize().background(Look.canvas)) {
        Box(Modifier.weight(1f).fillMaxWidth()) {
            CompositionLocalProvider(LocalNavBarShown provides true) { content() }
        }
        // Where the Van app's own bar was: at the bottom, just above the Field app's bar.
        if (show) {
            Box(Modifier.fillMaxWidth().height(1.dp).background(Look.hairline))
            SellTabRow(c)
        }
    }
}

/** Sync and the printer for selling (sign-in, password and sign-out stay on the Field app's own More). */
@Composable fun MoreScreen(c: VanController) {
    val last = c.sync.lastSyncTime?.let { Instant.ofEpochMilli(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d, h:mm a")) } ?: "Not yet"
    ScreenFrame("More", message = c.message, trailing = { SyncPill(c) }) {
        Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(Look.cardRadius), color = Look.card, border = androidx.compose.foundation.BorderStroke(1.dp, Look.hairline)) {
            Row(Modifier.padding(14.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Avatar(c.seller?.name ?: "Sunpride", size = 52.dp)
                Column(Modifier.weight(1f)) {
                    Text(c.seller?.name ?: "Signed in", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("Van seller" + (c.trip?.vehicle?.let { " · Truck ${it.vehicleCode}" } ?: ""),
                        style = MaterialTheme.typography.bodyMedium, color = Look.muted, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        ListRow("Sync now", if (c.sync.lastSyncTime == null) "Send saved work and check for changes" else "Last synced: $last", "sync-now", enabled = !c.busy, onClick = c::syncNow, glyph = GlyphKind.SYNC)
        ListRow("Sync & posting", "What is on this phone, with the office and in SAP", "open-sync", onClick = { c.open(Page.SYNC) }, glyph = GlyphKind.RECEIPT)
        ListRow("Printer & scanner", "Check the printer and paper", "open-printer", onClick = { c.open(Page.PRINTER) }, glyph = GlyphKind.PRINTER)
    }
}
