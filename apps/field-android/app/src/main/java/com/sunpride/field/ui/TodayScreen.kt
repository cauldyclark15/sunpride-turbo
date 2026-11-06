package com.sunpride.field.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.BorderStroke
import com.sunpride.field.ui.today.CallProgressCard
import com.sunpride.field.ui.today.NextStoreCard
import com.sunpride.field.ui.today.SalesCard
import com.sunpride.field.ui.today.TodaySummary
import com.sunpride.field.ui.today.outcomeLabel

/**
 * Today: where the day stands and what to do next. Top to bottom: the work-day card, progress, the stops in route order,
 * sales and targets. The next store is a floating bar above the navigation bar so Start is always one thumb away.
 * The page title lives in the app header; [showTitle] draws one here only when this screen is used on its own.
 */
@Composable
fun TodayScreen(data: TodayData, busy: Boolean, onSync: () -> Unit, onSignOut: () -> Unit,
    modifier: Modifier = Modifier, onVisit: (VisitDisplay) -> Unit = {}, diagnosticEnabled: Boolean = false,
    offline: Boolean = false, onRoute: (() -> Unit)? = null, onCustomers: (() -> Unit)? = null,
    onTeam: (() -> Unit)? = null, unplannedEnabled: Boolean = diagnosticEnabled, showTitle: Boolean = true,
    /** SP-0136 work-day card (Start day / End day, location sharing status). */
    workDay: (@Composable () -> Unit)? = null) {
    val summary = remember(data) { TodaySummary.of(data) }
    val bar = summary.planned > 0
    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = if (bar) 108.dp else 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (showTitle) {
                Text("Today", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.testTag("today-title"))
                Text(java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).format(
                    java.time.format.DateTimeFormatter.ofPattern("EEE, MMM d", java.util.Locale.ENGLISH)),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (onCustomers != null) FindStoreRow(data, onCustomers)
            workDay?.invoke()
            if (summary.planned > 0) CallProgressCard(summary)
            Column(Modifier.testTag("today-route"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                SectionTitle(summary.routeCode?.let { "Route $it · ${summary.planned} stops" } ?: "Visits · ${summary.planned}",
                    trailing = if (onRoute != null && data.visits.isNotEmpty()) ({
                        TextButton(onClick = onRoute, modifier = Modifier.heightIn(min = 48.dp).testTag("route-open")) {
                            Text("Map and distances", style = MaterialTheme.typography.labelLarge)
                        }
                    }) else null)
                if (data.visits.isEmpty()) EmptyState("No visits today",
                    if (data.lastSynced == null) "Sync to download today's plan." else "Nothing is planned for you today. Stores you are assigned to are under Stores.",
                    GlyphKind.TODAY, Modifier.testTag("today-empty"))
                summary.stops.forEach { stop -> StopRow(summary, stop, diagnosticEnabled, onVisit) }
            }
            if (onTeam != null && data.supervisor) LookCard {
                ListRow("Your team today", "Coverage and exceptions for your direct reports", "team",
                    Modifier.testTag("team-open"), onClick = onTeam)
            }
            SalesCard(data.sales)
            com.sunpride.catalogue.TargetProgressCard(data.targets,
                Modifier.border(1.dp, Look.hairline, MaterialTheme.shapes.medium))
            if (diagnosticEnabled && unplannedEnabled && data.unplannedOutlets.isNotEmpty()) SectionCard("Visit a store that is not on today's plan") {
                data.unplannedOutlets.forEach { outlet -> ListRow(outlet.outlet, "Unplanned visit", "store",
                    Modifier.testTag("unplanned-open"), onClick = { onVisit(outlet) }) }
            }
            data.warning?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("today-warning")) }
        }
        if (bar) Box(Modifier.align(Alignment.BottomCenter).fillMaxWidth().heightIn(min = 112.dp, max = 112.dp).background(
            androidx.compose.ui.graphics.Brush.verticalGradient(listOf(androidx.compose.ui.graphics.Color.Transparent,
                MaterialTheme.colorScheme.background.copy(alpha = 0.96f)))))
        if (bar) NextStoreCard(summary, onOpen = if (diagnosticEnabled) onVisit else null,
            modifier = Modifier.align(Alignment.BottomCenter).padding(start = 16.dp, end = 16.dp, bottom = 12.dp))
    }
}

/** Looks like the POS search box; opens Stores, where the search lives. */
@Composable
private fun FindStoreRow(data: TodayData, onOpen: () -> Unit) {
    Surface(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("customers-open")
        .semantics(mergeDescendants = true) {}, shape = RoundedCornerShape(Look.pill), color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.5.dp, Look.hairline)) {
        Row(Modifier.padding(horizontal = 18.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Glyph(GlyphKind.SEARCH, MaterialTheme.colorScheme.onSurfaceVariant, 22.dp)
            Column(Modifier.weight(1f)) {
                Text("Find a store", style = MaterialTheme.typography.bodyLarge)
                Text(if (data.customers.isEmpty() && data.lastSynced != null) "No outlets on your plan today"
                    else if (data.customers.isEmpty()) "Sync to download your outlets"
                    else "${data.customers.size} outlets saved on this phone",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Glyph(GlyphKind.CHEVRON, MaterialTheme.colorScheme.onSurfaceVariant, 20.dp)
        }
    }
}

@Composable
private fun StopRow(summary: TodaySummary, stop: com.sunpride.field.ui.today.RouteStop, diagnosticEnabled: Boolean,
    onVisit: (VisitDisplay) -> Unit) {
    val visit = stop.visit
    val isNext = summary.next?.stop == stop.stop
    val facts = listOfNotNull(visit.planned.takeUnless { it == "Planned" || it == "Scheduled" || it.isBlank() },
        visit.status.takeUnless { it == "Planned" || it == "Scheduled" || it == "Pending" || it.isBlank() }
            ?.replace("Queued", "Waiting"), outcomeLabel(summary, stop), visit.timeSpent)
    val chip: @Composable () -> Unit = {
        when {
            stop.needsReview -> StatusChip("Needs review", Look.Tone.BAD)
            stop.done -> StatusChip("Done", Look.Tone.GOOD)
            stop.inProgress -> StatusChip("In progress", Look.Tone.ACCENT)
            isNext -> StatusChip("Next", Look.Tone.ACCENT)
        }
    }
    val leading: @Composable () -> Unit = {
        if (stop.done) Box(Modifier.size(40.dp).clip(CircleShape).background(Look.fill(Look.Tone.GOOD)), contentAlignment = Alignment.Center) {
            Glyph(GlyphKind.CHECK, Look.text(Look.Tone.GOOD), 20.dp)
        } else IconTile(stop.stop.toString(), emphasis = isNext || stop.inProgress)
    }
    val shape = SunprideTokens.shapes.large
    Surface(Modifier.fillMaxWidth().then(if (diagnosticEnabled) Modifier.testTag("today-visit") else Modifier), shape = shape, color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(if (isNext || stop.inProgress) 1.5.dp else 1.dp, if (isNext || stop.inProgress) Look.accent else Look.hairline)) {
        ListRow(visit.outlet, facts.filterNot { it == "Done" || it == "In progress" || it == "Needs review" }.joinToString(" · "),
            "store", Modifier.testTag(if (diagnosticEnabled) "diagnostic-open" else "today-visit"),
            onClick = if (diagnosticEnabled) ({ onVisit(visit) }) else null, tile = stop.stop.toString(),
            trailingContent = chip, leading = leading)
    }
}
