package com.sunpride.field.ui.diagnosticvisit

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sunpride.field.ui.FieldController
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
        if (!granted) locationError = "Location denied. Check-in is blocked; allow precise location in app settings."
        else scope.launch {
            val fix = location.fix()
            if (fix == null) locationError = "No location fix. Check-in is blocked; try again outdoors."
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
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("DEV diagnostic visit", modifier = Modifier.testTag("diagnostic-title"))
        Text(visit.outlet)
        Text("Offline queue only. Location evidence is pending server review; no geofence or productivity credit is claimed.")
        TextButton(onClick = onBack) { Text("Back to Today") }
        if (visit.plannedVisitId == null) OutlinedTextField(reason, { reason = it },
            label = { Text("Unplanned reason (required)") }, modifier = Modifier.fillMaxWidth().testTag("unplanned-reason"))
        locationError?.let { Text(it, modifier = Modifier.testTag("location-error")) }
        controller.diagnosticError?.let { Text(it, modifier = Modifier.testTag("queue-error")) }
        Button(onClick = {
            locationError = null
            if (location.requiresPermission && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                launcher.launch(Manifest.permission.ACCESS_FINE_LOCATION)
            else scope.launch {
                val fix = location.fix()
                if (fix == null) locationError = "No location fix. Check-in is blocked; try again outdoors."
                else controller.queueDiagnostic("visit.checkIn", reason, null, null, fix)
            }
        }, enabled = !controller.busy && (visit.plannedVisitId != null || reason.isNotBlank()) &&
            related.none { it.first.kind == "visit.checkIn" && it.second != "review" },
            modifier = Modifier.testTag("diagnostic-checkin")) { Text("Check in") }
        OutlinedTextField(note, { note = it }, label = { Text("Optional note") },
            modifier = Modifier.fillMaxWidth().testTag("diagnostic-note"))
        Button(onClick = { controller.queueDiagnostic("visit.activity", null, note, null, null); note = "" },
            enabled = !controller.busy && note.isNotBlank() && related.any { it.first.kind == "visit.checkIn" },
            modifier = Modifier.testTag("diagnostic-add-note")) { Text("Add note") }
        TextButton(onClick = { outcome = if (outcome == "completed") "nonproductive" else "completed" }) {
            Text("Outcome: $outcome (tap to change)")
        }
        Button(onClick = { controller.queueDiagnostic("visit.checkOut", null, null, outcome, null) },
            enabled = !controller.busy && related.any { it.first.kind == "visit.checkIn" } &&
                related.none { it.first.kind == "visit.checkOut" },
            modifier = Modifier.testTag("diagnostic-checkout")) { Text("Check out") }
        Text("Operations")
        related.forEach { (intent, state) ->
            Text("${intent.kind.substringAfter('.')}: " + when (state) {
                "pending" -> "Queued"
                "done" -> "Accepted"
                else -> "Needs review"
            }, modifier = Modifier.testTag("diagnostic-operation"))
        }
        val review = controller.diagnosticRows.filter { it.second == "review" }
        if (review.isNotEmpty()) {
            Text("Needs review (${review.size})", modifier = Modifier.testTag("review-list"))
            review.forEach { Text(it.first.kind.substringAfter('.')) }
        }
    }
}
