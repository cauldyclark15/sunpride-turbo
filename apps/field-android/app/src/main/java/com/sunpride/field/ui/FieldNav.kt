package com.sunpride.field.ui

import androidx.compose.ui.unit.Density
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Badge
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** The five places a seller works from. Every screen of the app belongs to one of them. */
enum class FieldTab(val page: String, val label: String, val glyph: GlyphKind, val tag: String) {
    TODAY("home", "Today", GlyphKind.TODAY, "nav-today"),
    ROUTE("route", "Route", GlyphKind.ROUTE, "nav-route"),
    STORES("customers", "Customers", GlyphKind.STORE, "nav-stores"),
    MESSAGES("messages", "Messages", GlyphKind.CHAT, "nav-messages"),
    MORE("more", "More", GlyphKind.MORE, "nav-more"),
}

object FieldNav {
    /** Largest text scale the bottom bar's labels use; five labels must fit side by side on a 360 dp phone. */
    const val MAX_BAR_LABEL_SCALE = 1.0f
    fun barLabelFontScale(system: Float): Float = minOf(system, MAX_BAR_LABEL_SCALE)
    /** Pages that are the root of a tab: no Back arrow, system Back returns to Today. */
    val tabRoots: Set<String> = FieldTab.entries.map { it.page }.toSet()

    /** Pages that are forms or one-time steps: the bar steps aside so it cannot pull the seller out mid-entry. */
    val noBarPages: Set<String> = setOf("change-password", "location-consent", "location-background", "location-battery",
        "census", "workforce", "jointcall", "collections")

    /** Pages reached from somewhere else (Account, Sync, a tool): Back returns to the page they opened from. */
    val overlayPages: Set<String> = setOf("account", "sync", "support", "change-password", "incentives", "catalogue", "census",
        "team", "workforce", "jointcall", "collections", "location-consent", "location-background", "location-battery")

    /** Pages FieldApp shows even while a visit is open (they come before the visit screens in its `when`). */
    val pagesAheadOfVisit: Set<String> = setOf("account", "incentives", "change-password", "support", "location-consent",
        "location-background", "location-battery", "collections", "jointcall", "catalogue", "census", "workforce", "messages",
        "sync", "more")

    /** The tab a page belongs to (drill-down pages keep their parent tab selected). */
    fun tabOf(page: String): FieldTab = when (page) {
        "home" -> FieldTab.TODAY
        "route" -> FieldTab.ROUTE
        "customers", "customer" -> FieldTab.STORES
        "messages" -> FieldTab.MESSAGES
        else -> FieldTab.MORE
    }

    fun barVisible(ready: Boolean, locked: Boolean, partnerMode: Boolean, visitOpen: Boolean, page: String): Boolean =
        ready && !locked && !partnerMode && !visitOpen && page !in noBarPages
}

/**
 * Material 3 navigation bar, 5 labelled destinations. The selected one gets the pale red pill and red icon; Messages carries
 * the unread count. White like the sheet, with a hairline on top, so it reads as part of the page.
 */
@Composable
fun FieldBottomBar(selected: FieldTab, unread: Int, onSelect: (FieldTab) -> Unit, modifier: Modifier = Modifier) {
    val line = Look.hairline
    NavigationBar(modifier.drawBehind { drawLine(line, Offset(0f, 0f), Offset(size.width, 0f), strokeWidth = 1.dp.toPx()) },
        containerColor = MaterialTheme.colorScheme.background, tonalElevation = 0.dp) {
        FieldTab.entries.forEach { tab ->
            val on = tab == selected
            NavigationBarItem(selected = on, onClick = { onSelect(tab) },
                modifier = Modifier.testTag(tab.tag),
                icon = {
                    val glyph = @Composable { Glyph(tab.glyph, if (on) Look.onTint else Look.muted, 24.dp) }
                    if (tab == FieldTab.MESSAGES && unread > 0) BadgedBox(badge = {
                        Badge(containerColor = Look.accent, contentColor = Look.onAccent,
                            modifier = Modifier.testTag("nav-messages-badge")) { Text(if (unread > 99) "99+" else "$unread") }
                    }, modifier = Modifier.semantics { contentDescription = "Messages, $unread unread" }) { glyph() }
                    else glyph()
                },
                label = {
                    // FLD-173: at the phone's largest font the five labels would clip ("Toda", "Mess");
                    // the bar caps its own label scale so every label stays whole and readable.
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

/** True while the on-screen keyboard is up: the bar hides so a form keeps its room. */
@Composable
fun rememberImeVisible(): Boolean {
    val density = LocalDensity.current
    return WindowInsets.ime.getBottom(density) > 0
}
