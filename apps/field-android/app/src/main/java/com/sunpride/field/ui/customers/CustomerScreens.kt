package com.sunpride.field.ui.customers

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
import com.sunpride.field.ui.LabeledField
import com.sunpride.field.ui.ListRow
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
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
    val results = remember(data.customers, query) { CustomerDirectory.search(data.customers, query) }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())
        .padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        LabeledField("Search name, code or address", query, { query = it.take(80) },
            Modifier.fillMaxWidth().testTag("customer-search"),
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search))
        Text(listOfNotNull(
            when {
                data.customers.isEmpty() -> "No outlets on this phone"
                query.isBlank() -> "${data.customers.size} outlets"
                else -> "${results.size} of ${data.customers.size} outlets"
            },
            "Saved on this phone".takeIf { offline || data.stale },
        ).joinToString(" · "), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("customer-count"))
        when {
            data.customers.isEmpty() -> Text("Sync to download the outlets on your plan",
                style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("customer-empty"))
            results.isEmpty() -> Text("No outlet matches \"${query.trim()}\". Only outlets on your plan are on this phone.",
                style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("customer-no-match"))
            else -> SectionCard("Outlets") {
                results.forEach { record ->
                    ListRow(record.name, resultMeta(record, now), "store",
                        Modifier.testTag("customer-result"), onClick = { onOpen(record.outletId) })
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

private fun resultMeta(record: CustomerRecord, now: Long): String = listOfNotNull(
    record.outletCode, record.customerCode?.takeIf { it != record.outletCode },
    record.today?.let { "Today" } ?: record.planned.firstOrNull()?.let { CustomerDirectory.dayLabel(it.serviceDate, now) },
    record.address,
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
        .padding(horizontal = 20.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.semantics(mergeDescendants = true) {}.testTag("customer-header")) {
            Text(record.name, style = MaterialTheme.typography.headlineSmall)
            Text(listOfNotNull(record.outletCode, record.customerCode?.takeIf { it != record.outletCode },
                "Saved on this phone".takeIf { data.stale }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton("Navigate", {
                navigation?.let { actionError = if (onNavigate(it)) null else "No maps app on this phone" }
            }, Modifier.weight(1f).testTag("customer-navigate"), enabled = navigation != null)
            SecondaryButton("Call", {
                dial?.let { actionError = if (onDial(it)) null else "No phone app on this device" }
            }, Modifier.weight(1f).testTag("customer-call"), enabled = dial != null)
        }
        // SP-0124: an outlet that is not on today's plan offers a visit only when unplanned visits are on.
        if (visitEnabled && (record.today != null || unplannedEnabled)) {
            val today = record.today
            SecondaryButton(when {
                today == null -> "Unplanned visit"
                today.status == "In progress" -> "Continue visit"
                else -> "Open visit"
            }, {
                onVisit(today ?: VisitDisplay(record.name, "Unplanned", "Reason required", record.outletId))
            }, Modifier.fillMaxWidth().testTag("customer-visit"))
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
        Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
        Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.weight(1.2f))
    }
    HorizontalDivider(color = MaterialTheme.colorScheme.outline.copy(alpha = 0.22f))
}

@Composable
private fun Note(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp))
}
