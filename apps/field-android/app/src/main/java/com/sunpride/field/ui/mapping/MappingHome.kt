package com.sunpride.field.ui.mapping

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.Glyph
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.LookCard
import com.sunpride.field.ui.SectionTitle
import com.sunpride.field.ui.StatusChip
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/** SP-0195: one Add customer save on this phone (the outbox row of a new-customer capture, never an Edit request). */
data class MappingSave(val name: String, val barangay: String?, val sent: Boolean, val savedAt: Long)

/** SP-0195 Customer mapping Home: counted from the phone's own saves, so it works offline. */
object MappingHome {
    val ZONE: ZoneId = ZoneId.of("Asia/Manila")

    data class Counts(val today: Int, val week: Int)

    /** Saves today and this week (Monday to now), in Philippine time. */
    fun counts(saves: List<MappingSave>, now: Long, zone: ZoneId = ZONE): Counts {
        val day = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        val dayStart = day.atStartOfDay(zone).toInstant().toEpochMilli()
        val weekStart = day.with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).atStartOfDay(zone).toInstant().toEpochMilli()
        return Counts(saves.count { it.savedAt in dayStart..now }, saves.count { it.savedAt in weekStart..now })
    }

    /** The newest five. */
    fun recent(saves: List<MappingSave>): List<MappingSave> = saves.sortedByDescending { it.savedAt }.take(5)

    fun stateLabel(save: MappingSave): String = if (save.sent) "Sent" else "Waiting to send"
}

/**
 * SP-0195: the Customer mapping tab root. One big Add customer button, today's and this week's counts and the last five
 * customers saved. The plain sync line ("All sent" / "Waiting to send (N)" / "Waiting for signal") is the header's
 * sync pill right above it, so it is not repeated here. Nothing about visits, routes, plans, targets or selling.
 */
@Composable
fun MappingHomeScreen(saves: List<MappingSave>, now: Long, onAddCustomer: () -> Unit, modifier: Modifier = Modifier) {
    val counts = MappingHome.counts(saves, now)
    val recent = MappingHome.recent(saves)
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp)
        .testTag("mapping-home"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Button(onClick = onAddCustomer, modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp).testTag("mapping-add-customer"),
            shape = RoundedCornerShape(24.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Look.accent, contentColor = Look.onAccent)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Glyph(GlyphKind.PLUS, Look.onAccent, 30.dp)
                Text("Add customer", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            CountCard("Added today", counts.today, "mapping-count-today", Modifier.weight(1f))
            CountCard("This week", counts.week, "mapping-count-week", Modifier.weight(1f))
        }
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            SectionTitle("Last saved")
            LookCard {
                if (recent.isEmpty()) Text("Customers you add show here.", style = MaterialTheme.typography.bodyMedium,
                    color = Look.muted, modifier = Modifier.padding(16.dp).testTag("mapping-recent-empty"))
                recent.forEachIndexed { i, save ->
                    if (i > 0) HorizontalDivider(Modifier.padding(start = 16.dp), color = Look.hairline.copy(alpha = 0.7f))
                    RecentRow(save, Modifier.testTag("mapping-recent-$i"))
                }
            }
        }
    }
}

@Composable
private fun CountCard(label: String, count: Int, tag: String, modifier: Modifier = Modifier) {
    LookCard(modifier.semantics(mergeDescendants = true) { contentDescription = "$label: $count" }) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("$count", style = MaterialTheme.typography.displaySmall, fontWeight = FontWeight.SemiBold,
                color = MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag(tag))
            Text(label, style = MaterialTheme.typography.bodyMedium, color = Look.muted)
        }
    }
}

@Composable
private fun RecentRow(save: MappingSave, modifier: Modifier = Modifier) {
    Row(modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text(save.name, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            save.barangay?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Look.muted, maxLines = 1,
                overflow = TextOverflow.Ellipsis) }
        }
        StatusChip(MappingHome.stateLabel(save), if (save.sent) Look.Tone.GOOD else Look.Tone.NEUTRAL)
    }
}
