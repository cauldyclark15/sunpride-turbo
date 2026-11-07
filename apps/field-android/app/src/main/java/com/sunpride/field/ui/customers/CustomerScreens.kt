package com.sunpride.field.ui.customers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.EmptyState
import com.sunpride.field.ui.FilterPill
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.IconTile
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SearchField
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.StatusChip
import com.sunpride.field.ui.TonalButton
import com.sunpride.field.ui.Glyph
import com.sunpride.field.ui.SunprideTokens
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Surface
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.route.DailyRoutes

/**
 * Customer search (AND-011): searches only the outlets downloaded for this person, so it works
 * with no signal and can never reveal an outlet outside their scope.
 */
@Composable
fun CustomerSearchScreen(data: TodayData, onOpen: (String) -> Unit, modifier: Modifier = Modifier,
    offline: Boolean = false, now: Long = System.currentTimeMillis()) {
    var query by rememberSaveable { mutableStateOf("") }
    var onlyToday by rememberSaveable { mutableStateOf(false) }
    val found = remember(data.customers, query) { CustomerDirectory.search(data.customers, query) }
    val todayCount = remember(data.customers) { data.customers.count { it.today != null } }
    val results = if (onlyToday) found.filter { it.today != null } else found
    // SP-0140: a lazy list, so a scope with hundreds of outlets composes only the rows on screen.
    LazyColumn(modifier.fillMaxSize().testTag("customer-list"),
        contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp)) {
        item(key = "search") {
            SearchField(query, { query = it.take(80) }, "Search name, code or address",
                Modifier.padding(bottom = 4.dp).testTag("customer-search"),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search))
        }
        if (todayCount > 0) item(key = "filters") {
            androidx.compose.foundation.layout.Row(Modifier.padding(bottom = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterPill("All", !onlyToday, { onlyToday = false }, count = data.customers.size)
                FilterPill("On today's route", onlyToday, { onlyToday = true }, count = todayCount)
            }
        }
        item(key = "count") {
            Text(listOfNotNull(
                when {
                    data.customers.isEmpty() -> "No outlets on this phone"
                    query.isBlank() -> "${data.customers.size} outlets"
                    else -> "${found.size} of ${data.customers.size} outlets"
                },
                "Saved on this phone".takeIf { offline || data.stale },
            ).joinToString(" · "), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp, bottom = 8.dp, top = 4.dp).testTag("customer-count"))
        }
        when {
            data.customers.isEmpty() -> item(key = "empty") {
                EmptyState(if (data.lastSynced != null) "No outlets are on your plan for today and the next two days"
                    else "Sync to download the outlets on your plan",
                    "Stores on your route appear here, and stay searchable with no signal.", GlyphKind.STORE,
                    Modifier.testTag("customer-empty"))
            }
            results.isEmpty() -> item(key = "no-match") {
                Text(if (query.isBlank()) "No outlets on today's route yet. Choose All to see every outlet."
                    else "No outlet matches \"${query.trim()}\". Only outlets on your plan are on this phone.",
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(4.dp).testTag("customer-no-match"))
            }
            else -> items(results, key = { it.outletId }) { record -> StoreRow(record, now) { onOpen(record.outletId) } }
        }
    }
}

@Composable
private fun StoreRow(record: CustomerRecord, now: Long, onClick: () -> Unit) {
    val visit = record.today
    val emphasis = visit != null && visit.status != "Done"
    Surface(onClick = onClick, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).testTag("customer-result"),
        shape = SunprideTokens.shapes.large, color = MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, Look.hairline)) {
        androidx.compose.foundation.layout.Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            IconTile(record.name.trim().take(1).uppercase(), emphasis)
            Column(Modifier.weight(1f)) {
                Text(record.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                resultMeta(record, now, withAddress = false).takeIf { it.isNotEmpty() }?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                record.address?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
            when (visit?.status) {
                "Done" -> StatusChip("Done", Look.Tone.GOOD)
                "In progress" -> StatusChip("In progress", Look.Tone.ACCENT)
                "Needs review" -> StatusChip("Needs review", Look.Tone.BAD)
            }
            Glyph(GlyphKind.CHEVRON, MaterialTheme.colorScheme.onSurfaceVariant, 20.dp)
        }
    }
}

private fun resultMeta(record: CustomerRecord, now: Long, withAddress: Boolean = true): String = listOfNotNull(
    record.outletCode, record.customerCode?.takeIf { it != record.outletCode },
    record.today?.let { "Today" } ?: record.planned.firstOrNull()?.let { CustomerDirectory.dayLabel(it.serviceDate, now) },
    record.address.takeIf { withAddress },
).joinToString(" · ")

/**
 * Outlet detail: account summary, route, planned calls and tasks, this phone's recent history and
 * the actions a salesperson takes from here (directions, call the buyer, open the visit).
 */
@Composable
fun CustomerDetailScreen(record: CustomerRecord, data: TodayData, onNavigate: (String) -> Boolean,
    onDial: (String) -> Boolean, modifier: Modifier = Modifier, onVisit: (VisitDisplay) -> Unit = {},
    visitEnabled: Boolean = false, now: Long = System.currentTimeMillis(), unplannedEnabled: Boolean = visitEnabled) {
    var actionError by remember { mutableStateOf<String?>(null) }
    val navigation = DailyRoutes.navigationUri(record.asVisit())
    val dial = CustomerDirectory.dialUri(record.account?.contactNumber)
    val stop = remember(data.visits, record.outletId) {
        DailyRoutes.build(data.visits, null).stops.firstOrNull { it.visit.outletId == record.outletId }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())
        .padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.semantics(mergeDescendants = true) {}.testTag("customer-header"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(record.name, style = MaterialTheme.typography.headlineSmall)
            Text(listOfNotNull(record.outletCode, record.customerCode?.takeIf { it != record.outletCode },
                "Saved on this phone".takeIf { data.stale }).joinToString(" · "),
                style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // SP-0124: an outlet that is not on today's plan offers a visit only when unplanned visits are on.
        if (visitEnabled && (record.today != null || unplannedEnabled)) {
            val today = record.today
            val label = when {
                today == null -> "Unplanned visit"
                today.status == "In progress" -> "Continue visit"
                else -> "Open visit"
            }
            val go = { onVisit(today ?: VisitDisplay(record.name, "Unplanned", "Reason required", record.outletId)) }
            if (today != null) PrimaryBottomButton(label, go, Modifier.testTag("customer-visit"))
            else SecondaryButton(label, go, Modifier.fillMaxWidth().testTag("customer-visit"))
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TonalButton("Navigate", {
                navigation?.let { actionError = if (onNavigate(it)) null else "No maps app on this phone" }
            }, Modifier.weight(1f).testTag("customer-navigate"), enabled = navigation != null, glyph = GlyphKind.NAVIGATE)
            TonalButton("Call", {
                dial?.let { actionError = if (onDial(it)) null else "No phone app on this device" }
            }, Modifier.weight(1f).testTag("customer-call"), enabled = dial != null, glyph = GlyphKind.PHONE)
        }
        actionError?.let { Text(it, color = MaterialTheme.colorScheme.error,
            style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("customer-action-error")) }

        SectionCard("Summary", Modifier.semantics(mergeDescendants = true) {}.testTag("customer-summary")) {
            val account = record.account
            Fact("Outlet code", record.outletCode ?: "Not sent")
            record.customerCode?.let { Fact("Customer code", it) }
            Fact("Address", record.address ?: account?.address ?: "No address yet")
            Fact("Location", when {
                record.latitude != null -> "Verified pin"
                navigation != null -> "Address only, no verified pin"
                else -> "No pin or address yet"
            })
            account?.takeIf { it.accountName != record.name }?.let { Fact("Account", it.accountName) }
            account?.buyerName?.let { Fact("Buyer", it) }
            account?.contactNumber?.let { Fact("Contact", it) }
            account?.accountInCharge?.let { Fact("Account in charge", it) }
            account?.receivingInCharge?.let { Fact("Receiving", it) }
            account?.distributorName?.let { Fact("Distributor", it) }
            account?.distributorSchedule?.let { Fact("Delivery schedule", it) }
            account?.foc?.let { Fact("FOC", it) }
            if (account == null) Note("No account sheet set up by the office yet")
        }

        SectionCard("Route", Modifier.semantics(mergeDescendants = true) {}.testTag("customer-route")) {
            Fact("Route", record.routeCode ?: if (record.routeId == null) "Not on a route" else "Another route")
            if (stop != null) {
                Fact("Today", "Stop ${stop.number} of ${data.visits.size} · ${stop.state.label}")
                stop.visit.timeSpent?.let { Fact("Time spent", it) }
            } else Fact("Today", "Not on today's plan")
        }

        SectionCard("Planned visits", Modifier.semantics(mergeDescendants = true) {}.testTag("customer-planned")) {
            if (record.planned.isEmpty()) Note("No planned visits in the next days")
            record.planned.forEach { plan ->
                Fact(CustomerDirectory.dayLabel(plan.serviceDate, now),
                    plan.intents.joinToString(", ") { CustomerDirectory.kindLabel(it) }.ifEmpty { "Visit" })
            }
        }

        SectionCard("Tasks", Modifier.semantics(mergeDescendants = true) {}.testTag("customer-tasks")) {
            val todays = record.today?.intents.orEmpty()
            todays.forEach { Fact(CustomerDirectory.kindLabel(it), "This outlet today") }
            data.tasks.forEach { task ->
                Fact(CustomerDirectory.kindLabel(task.kind), if (task.required) "Required · your day" else "Your day")
            }
            if (todays.isEmpty() && data.tasks.isEmpty()) Note("No tasks for this outlet today")
        }

        SectionCard("Recent history", Modifier.semantics(mergeDescendants = true) {}.testTag("customer-history")) {
            if (record.history.isEmpty()) Note("Nothing recorded here from this phone yet")
            record.history.forEach { entry ->
                Fact(entry.label, "${CustomerDirectory.timeLabel(entry.at, now)} · ${entry.state}")
            }
            Note("Shows visits recorded on this phone. Office history is not downloaded.")
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun Fact(label: String, value: String) {
    Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(horizontal = 16.dp, vertical = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(label, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1.3f))
    }
    HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = Look.hairline.copy(alpha = 0.7f))
}

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
}
