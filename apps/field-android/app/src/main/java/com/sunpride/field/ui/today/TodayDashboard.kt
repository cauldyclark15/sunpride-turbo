package com.sunpride.field.ui.today

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.ListRow
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.ValueRow
import com.sunpride.field.ui.VisitDisplay

/** Short closed-call label for a route row; null while the call is not finished. */
fun outcomeLabel(visit: VisitDisplay): String? = when {
    visit.status != TodaySummary.STATUS_DONE -> null
    visit.outcome == TodaySummary.OUTCOME_PRODUCTIVE -> "Productive"
    visit.outcome == "nonproductive" -> "Not productive"
    else -> null
}

fun productiveLine(summary: TodaySummary): String = summary.productivePercent?.let {
    "Productive ${summary.productive} of ${summary.done} finished · $it%"
} ?: "Productive · no calls ended yet"

@Composable
fun CallProgressCard(summary: TodaySummary, modifier: Modifier = Modifier) {
    SectionCard("Calls", modifier.testTag("today-progress")) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("${summary.done} of ${summary.planned}", style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("today-calls"))
                Text("done", style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
            }
            LinearProgressIndicator(progress = { summary.progress }, modifier = Modifier.fillMaxWidth().height(6.dp),
                color = MaterialTheme.colorScheme.onSurface,
                trackColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.22f), gapSize = 0.dp, drawStopIndicator = {})
            Text(productiveLine(summary), style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.testTag("today-productive"))
        }
    }
}

@Composable
fun NextStoreCard(summary: TodaySummary, onOpen: ((VisitDisplay) -> Unit)?, modifier: Modifier = Modifier) {
    val next = summary.next
    SectionCard(if (next?.inProgress == true) "Current call" else "Next store", modifier.testTag("today-next")) {
        if (next == null) Text(if (summary.allDone) "All planned stores visited" else "No store to visit",
            Modifier.padding(16.dp).testTag("today-all-done"))
        else ListRow(next.visit.outlet, listOfNotNull("Stop ${next.stop} of ${summary.planned}",
                if (next.needsReview) TodaySummary.STATUS_REVIEW else null).joinToString(" · "), "store",
            Modifier.testTag("today-next-store"), onClick = onOpen?.let { open -> { open(next.visit) } },
            tile = next.stop.toString())
    }
}

/** The v1 phone contract carries no sales target or sales amounts; never show invented zeros. */
@Composable
fun SalesCard(modifier: Modifier = Modifier) {
    SectionCard("Sales", modifier.testTag("today-sales")) {
        ValueRow("Target", "Not on phone yet")
        ValueRow("Sold today", "Not on phone yet")
    }
}
