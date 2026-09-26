package com.sunpride.field.ui.diagnosticvisit

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.LabeledField
import com.sunpride.field.ui.ListRow
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.VisitDisplay
import kotlinx.coroutines.launch
import org.json.JSONObject

@Composable
fun DiagnosticVisitScreen(visit: VisitDisplay, controller: FieldController, location: VisitLocation,
    onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var reason by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    var outcome by remember { mutableStateOf("completed") }
    var locationError by remember { mutableStateOf<String?>(null) }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) locationError = "Location off · Allow precise location"
        else scope.launch {
            val fix = location.fix()
            if (fix == null) locationError = "No location fix · Try outdoors"
            else controller.queueDiagnostic("visit.checkIn", reason, null, null, fix)
        }
    }
    val related = controller.diagnosticRows.filter { row ->
        row.first.kind == "visit.checkIn" &&
            JSONObject(row.first.serializedOperation).getJSONObject("payload").optString("outletId") == visit.outletId ||
            controller.diagnosticRows.any { it.first.kind == "visit.checkIn" &&
                JSONObject(it.first.serializedOperation).getJSONObject("payload").optString("outletId") == visit.outletId &&
                it.first.clientVisitId == row.first.clientVisitId }
    }
    val checkedIn = related.any { it.first.kind == "visit.checkIn" && it.second != "review" }
    val checkedOut = related.any { it.first.kind == "visit.checkOut" }
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(visit.outlet, style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("diagnostic-title"))
            Text(listOfNotNull(visit.planned.takeUnless { it == "Scheduled" },
                when { checkedOut -> "Done"; checkedIn -> "In progress"; else -> "Not started" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!checkedIn && visit.plannedVisitId == null) SectionCard("Check in") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Unplanned visit", style = MaterialTheme.typography.bodyMedium)
                        Switch(checked = true, onCheckedChange = null,
                            enabled = false, modifier = Modifier.testTag("unplanned-toggle"))
                    }
                    LabeledField("Reason", reason, { reason = it },
                        Modifier.fillMaxWidth().testTag("unplanned-reason"))
                }
            }
            if (checkedIn && !checkedOut) {
                SectionCard("Note") {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row {
                            androidx.compose.material3.OutlinedTextField(note, { note = it }, singleLine = true,
                                modifier = Modifier.fillMaxWidth().height(56.dp).testTag("diagnostic-note"),
                                placeholder = { Text("Add a note (optional)") },
                                shape = com.sunpride.field.ui.SunprideTokens.shapes.small,
                                textStyle = MaterialTheme.typography.bodyMedium,
                                colors = androidx.compose.material3.OutlinedTextFieldDefaults.colors(
                                    focusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                                    unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)))
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                            com.sunpride.field.ui.SecondaryButton("Add note", onClick = {
                                controller.queueDiagnostic("visit.activity", null, note, null, null); note = ""
                            }, enabled = !controller.busy && note.isNotBlank(),
                                modifier = Modifier.testTag("diagnostic-add-note"))
                        }
                    }
                }
                SectionCard("Outcome") {
                    Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        androidx.compose.material3.Surface(onClick = { outcome = if (outcome == "completed") "nonproductive" else "completed" },
                            modifier = Modifier.fillMaxWidth().height(48.dp).testTag("diagnostic-outcome")) {
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                                Text(if (outcome == "completed") "Completed" else "Not productive",
                                    style = MaterialTheme.typography.bodyMedium)
                                Text("⌄", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (checkedOut) SectionCard("Done") { Text("Visit saved", Modifier.padding(16.dp)) }
            if (related.isNotEmpty()) SectionCard("Activity · ${related.size}") {
                related.forEach { (intent, state) ->
                    ListRow(when (intent.kind) {
                        "visit.checkIn" -> "Check-in"; "visit.activity" -> "Note";
                        "visit.checkOut" -> "Check-out"; else -> "Visit action"
                    }, when (state) { "pending" -> "Waiting"; "done" -> "Accepted"; else -> "Needs review" },
                        "activity", Modifier.testTag("diagnostic-operation"))
                }
            }
            locationError?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("location-error")) }
            controller.diagnosticError?.let { Text(it, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag("queue-error")) }
            androidx.compose.foundation.layout.Spacer(Modifier.height(16.dp).testTag("visit-bottom-space"))
        }
        if (!checkedOut) androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        if (!checkedIn) PrimaryBottomButton("Check in", {
            locationError = null
            if (location.requiresPermission && ContextCompat.checkSelfPermission(context,
                    Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                launcher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            else scope.launch {
                val fix = location.fix()
                if (fix == null) locationError = "No location fix · Try outdoors"
                else controller.queueDiagnostic("visit.checkIn", reason, null, null, fix)
            }
        }, Modifier.testTag("diagnostic-checkin"),
            !controller.busy && (visit.plannedVisitId != null || reason.isNotBlank()))
        else if (!checkedOut) PrimaryBottomButton("Check out",
            { controller.queueDiagnostic("visit.checkOut", null, null, outcome, null) },
            Modifier.testTag("diagnostic-checkout"), !controller.busy)
    }
}
