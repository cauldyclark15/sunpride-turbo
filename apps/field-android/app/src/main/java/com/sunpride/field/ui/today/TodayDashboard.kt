package com.sunpride.field.ui.today

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.Glyph
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.LookCard
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.ValueRow
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.floatingBar

/** Short finished-call label for a route row by the governed rule; null while the call is not finished. */
fun outcomeLabel(summary: TodaySummary, stop: RouteStop): String? = when {
    !stop.done || stop.visit.callFacts == null -> null
    summary.ruleMissing -> "Finished"
    summary.productive(stop) -> "Productive"
    else -> "Not productive"
}

fun productiveLine(summary: TodaySummary): String = if (summary.ruleMissing && summary.done > 0)
    "Productive · counted once the office sets your call rule" else if (!summary.productivityKnown)
    "Productive · earlier calls need an updated report" else summary.productivePercent?.let {
    "Productive ${summary.productive} of ${summary.done} finished · $it%"
} ?: "Productive · no calls ended yet"

/** Day progress at a glance: how many stores are done, a bar, and the productive-call line. */
@Composable
fun CallProgressCard(summary: TodaySummary, modifier: Modifier = Modifier) {
    LookCard(modifier.testTag("today-progress")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${summary.done} of ${summary.planned}", style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.testTag("today-calls"))
                Text("customers done", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
            }
            ProgressBar(summary.progress)
            Text(productiveLine(summary), style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("today-productive"))
        }
    }
}

/** A 10 dp rounded progress bar: accent fill on a hairline track. */
@Composable
fun ProgressBar(progress: Float, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().heightIn(min = 10.dp, max = 10.dp).clip(CircleShape).background(Look.hairline)) {
        if (progress > 0f) Box(Modifier.fillMaxWidth(progress.coerceIn(0.04f, 1f)).heightIn(min = 10.dp, max = 10.dp)
            .clip(CircleShape).background(Look.accent))
    }
}

/**
 * The next store, as the near-black floating bar: where to go and one tap to start or continue the call. With visits
 * switched off ([onOpen] null) it only names the store.
 */
@Composable
fun NextStoreCard(summary: TodaySummary, onOpen: ((VisitDisplay) -> Unit)?, modifier: Modifier = Modifier) {
    val next = summary.next
    Box(modifier.fillMaxWidth().floatingBar().testTag("today-next")) {
        if (next == null) Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Glyph(GlyphKind.CHECK, Color.White, 22.dp)
            Text(if (summary.allDone) "All planned customers visited" else "No customer to visit", color = Color.White,
                style = MaterialTheme.typography.titleSmall, modifier = Modifier.testTag("today-all-done"))
        } else Row(Modifier.fillMaxWidth().heightIn(min = 72.dp)
            .then(if (onOpen != null) Modifier.clickable(role = Role.Button) { onOpen(next.visit) } else Modifier)
            .semantics(mergeDescendants = true) {}.testTag("today-next-store").padding(start = 14.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(Modifier.size(44.dp).clip(CircleShape).background(Look.gradientEnd), contentAlignment = Alignment.Center) {
                Text(next.stop.toString(), color = Color.White, style = MaterialTheme.typography.titleSmall)
            }
            Column(Modifier.weight(1f)) {
                Text(if (next.inProgress) "Current call" else "Next customer", color = Color.White.copy(alpha = 0.78f),
                    style = MaterialTheme.typography.labelMedium)
                Text(next.visit.outlet, color = Color.White, style = MaterialTheme.typography.titleMedium, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                Text(listOfNotNull("Stop ${next.stop} of ${summary.planned}",
                    if (next.needsReview) TodaySummary.STATUS_REVIEW else null).joinToString(" · "),
                    color = Color.White.copy(alpha = 0.78f), style = MaterialTheme.typography.bodySmall)
            }
            if (onOpen != null) Box(Modifier.heightIn(min = 48.dp).clip(RoundedCornerShape(24.dp)).background(Look.gradientEnd)
                .padding(horizontal = 20.dp), contentAlignment = Alignment.Center) {
                Text(if (next.inProgress) "Continue" else "Start", color = Color.White, style = MaterialTheme.typography.labelLarge)
            }
        }
    }
}

/** Today's target and sales from the server's daily sales report; never invented zeros. */
@Composable
fun SalesCard(view: DaySalesView, modifier: Modifier = Modifier) {
    SectionCard("Sales", modifier.testTag("today-sales")) {
        val sales = view.sales
        if (sales == null) Text(view.message ?: "Sync to see sales", Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp)
            .testTag("today-sales-none"), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else {
            ValueRow("Target today", DaySalesText.target(sales), Modifier.testTag("today-sales-target"))
            ValueRow("Sold today", DaySalesText.sold(sales), Modifier.testTag("today-sales-sold"))
            ValueRow("This month", DaySalesText.month(sales), Modifier.testTag("today-sales-month"))
            view.savedAt?.let {
                Text(DaySalesText.savedNote(it), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp).testTag("today-sales-saved"))
            }
        }
    }
}
