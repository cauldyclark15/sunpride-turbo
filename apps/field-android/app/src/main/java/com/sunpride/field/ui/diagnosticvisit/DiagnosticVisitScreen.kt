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
    var outcome by remember { mutableStateOf<String?>(null) }
    var reasonCode by remember { mutableStateOf("") }
    var locationError by remember { mutableStateOf<String?>(null) }
    var capturing by remember { mutableStateOf(false) }
    var pendingKind by remember { mutableStateOf("visit.checkIn") }
    suspend fun captureAndQueue(kind: String) {
        try {
            // Even a precise-permission denial may leave approximate/network location available.
            val fix = location.captureOrNull()
            locationError = if (fix == null) "Location unavailable · recorded for review" else null
            controller.queueDiagnostic(kind, if (kind == "visit.checkIn") reason else reasonCode,
                null, if (kind == "visit.checkOut") outcome else null, fix).join()
        } finally { capturing = false }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        scope.launch { captureAndQueue(pendingKind) }
    }
    fun record(kind: String) {
        locationError = null; capturing = true; pendingKind = kind
        if (location.requiresPermission && ContextCompat.checkSelfPermission(context,
                Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            launcher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
        else scope.launch { captureAndQueue(kind) }
    }
    val related = controller.relatedCall(visit)
    val checkedIn = com.sunpride.field.storage.VisitCallRules.started(related)
    val checkedOut = com.sunpride.field.storage.VisitCallRules.closed(related)
    val startFailure = controller.startFailure(visit)
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(visit.outlet, style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("diagnostic-title"))
            Text(listOfNotNull(visit.planned.takeUnless { it == "Scheduled" },
                when { checkedOut -> "Done"; checkedIn -> "In progress"; else -> "Not started" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (!checkedIn && visit.plannedVisitId == null) SectionCard("Start") {
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
                                Text(when (outcome) { "completed" -> "Completed"; "nonproductive" -> "Not productive"; else -> "Choose outcome" },
                                    style = MaterialTheme.typography.bodyMedium)
                                Text("⌄", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (checkedIn && !checkedOut && outcome == "nonproductive") SectionCard("Nonproductive reason") {
                LabeledField("Reason code", reasonCode, { reasonCode = it },
                    Modifier.fillMaxWidth().padding(16.dp).testTag("diagnostic-reason"))
            }
            if (checkedOut) SectionCard("Done") {
                Text("Visit saved · ${com.sunpride.field.storage.VisitCallRules.timeSpent(related) ?: "0 min"}",
                    Modifier.padding(16.dp).testTag("call-time-spent"))
            }
            if (!checkedIn) startFailure?.let {
                Text(it.code.text, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("start-blocked"))
            }
            if (related.isNotEmpty()) SectionCard("Activity · ${related.size}") {
                related.forEach { (intent, state) ->
                    ListRow(when (intent.kind) {
                        "visit.checkIn" -> "Start"; "visit.activity" -> "Note";
                        "visit.checkOut" -> "End call"; else -> "Visit action"
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
        if (!checkedIn) PrimaryBottomButton("Start", { record("visit.checkIn") }, Modifier.testTag("diagnostic-checkin"),
            !controller.busy && !capturing && startFailure == null && (visit.plannedVisitId != null || reason.isNotBlank()))
        else if (!checkedOut) PrimaryBottomButton("End call", { record("visit.checkOut") },
            Modifier.testTag("diagnostic-checkout"), !controller.busy && !capturing && outcome != null &&
                (outcome != "nonproductive" || reasonCode.isNotBlank()))
    }
}
