package com.sunpride.field.ui.team

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard

/**
 * AND-020 Team page: each direct report's coverage today and the day's exceptions, from the server's
 * scoped summary (or the copy saved on this phone when offline). Read-only: decisions stay on the web.
 */
@Composable
fun TeamScreen(view: TeamView, directOnly: Boolean, loading: Boolean, now: Long,
    onFilter: (Boolean) -> Unit, onRefresh: () -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterButton("Direct reports", directOnly, !loading, Modifier.weight(1f).testTag("team-direct")) { onFilter(true) }
                FilterButton("Whole area", !directOnly, !loading, Modifier.weight(1f).testTag("team-all")) { onFilter(false) }
            }
            val summary = view.summary
            if (summary != null) Text(TeamText.headline(summary) + if (view.saved) " · Saved on this phone" else
                " · Updated ${TeamRepository.clock(summary.generatedAt)}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("team-summary"))
            view.message?.let {
                Text(it, style = MaterialTheme.typography.bodySmall,
                    color = if (view.notAllowed || summary == null) MaterialTheme.colorScheme.error
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("team-message"))
            }
            if (summary == null && view.message == null && loading)
                Text("Loading your team…", style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("team-loading"))
            if (summary != null) {
                SectionCard("People · ${summary.people.size}") {
                    if (summary.people.isEmpty()) Text(if (summary.directOnly)
                        "No direct reports are assigned to you. Try Whole area." else "No field people in your area.",
                        Modifier.padding(16.dp).testTag("team-empty"))
                    summary.people.forEachIndexed { index, person ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.22f))
                        PersonRow(person, TeamText.status(person, now, summary.dayCloseAt))
                    }
                }
                SectionCard("Exceptions · ${summary.openExceptions} to review") {
                    if (summary.exceptions.isEmpty()) Text("No exceptions today",
                        Modifier.padding(16.dp).testTag("team-no-exceptions"))
                    summary.exceptions.forEachIndexed { index, item ->
                        if (index > 0) HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.22f))
                        ExceptionRow(item, TeamText.kind(item, now, summary.dayCloseAt))
                    }
                    if (summary.totalExceptions > summary.exceptions.size) Text(
                        "Showing ${summary.exceptions.size} of ${summary.totalExceptions}. See the rest on the web.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(16.dp).testTag("team-more"))
                }
                if (summary.truncated && summary.totalExceptions <= summary.exceptions.size) Text(
                    "Your area is large; some people are not shown. Use the web to narrow by unit or channel.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.testTag("team-truncated"))
            }
        }
        Spacer(Modifier.height(12.dp))
        PrimaryBottomButton(if (loading) "Updating…" else "Update", onRefresh, Modifier.testTag("team-refresh"), !loading)
    }
}

@Composable
private fun FilterButton(label: String, selected: Boolean, enabled: Boolean, modifier: Modifier, onClick: () -> Unit) {
    SecondaryButton(if (selected) "✓ $label" else label, onClick,
        modifier.semantics { this.selected = selected }, enabled && !selected)
}

@Composable
private fun PersonRow(person: TeamPerson, status: String) {
    Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics(mergeDescendants = true) {}
        .testTag("team-person").padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(person.name, style = MaterialTheme.typography.titleSmall, maxLines = 1,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            Text(status, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text(listOfNotNull(person.positionLabel ?: person.channel, TeamText.coverage(person)).joinToString(" · "),
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        val flags = TeamText.flags(person)
        if (flags.isNotEmpty()) Text(flags, style = MaterialTheme.typography.bodySmall,
            color = if (person.openExceptions > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ExceptionRow(item: TeamException, label: String) {
    Column(Modifier.fillMaxWidth().heightIn(min = 56.dp).semantics(mergeDescendants = true) {}
        .testTag(if (item.open) "team-exception-open" else "team-exception").padding(horizontal = 16.dp, vertical = 10.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, style = MaterialTheme.typography.titleSmall, modifier = Modifier.weight(1f),
                color = if (item.open) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
            item.at?.let { Text(TeamRepository.clock(it), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(TeamText.detail(item), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}
