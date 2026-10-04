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
import androidx.compose.ui.semantics.semantics
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
    var locationNotice by remember { mutableStateOf<LocationNotice?>(null) }
    var capturing by remember { mutableStateOf(false) }
    var pendingKind by remember { mutableStateOf("visit.checkIn") }
    suspend fun captureAndQueue(kind: String) {
        try {
            // Even a precise-permission denial may leave approximate/network location available.
            val capture = location.captureOrUnavailable()
            // Governed exception: a missing, weak, old or mock fix is recorded and flagged for supervisor
            // review on the server (pin distance/geofence result), never a reason to refuse Start or End.
            locationNotice = LocationAssessment.notice(capture, System.currentTimeMillis())
            controller.queueDiagnostic(kind, if (kind == "visit.checkIn") reason else reasonCode,
                null, if (kind == "visit.checkOut") outcome else null, capture.wire).join()
        } finally { capturing = false }
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        scope.launch { captureAndQueue(pendingKind) }
    }
    fun record(kind: String) {
        locationNotice = null; capturing = true; pendingKind = kind
        // Ask for precise and approximate together so Android 12+ lets the person choose either.
        if (location.requiresPermission && ContextCompat.checkSelfPermission(context,
                Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            launcher.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        else scope.launch { captureAndQueue(kind) }
    }
    val related = controller.relatedCall(visit)
    val checkedIn = com.sunpride.field.storage.VisitCallRules.started(related)
    val checkedOut = com.sunpride.field.storage.VisitCallRules.closed(related)
    val startFailure = controller.startFailure(visit)
    val intents = controller.visitIntents(visit)
    val checklist = controller.activityChecklist(visit)
    val missing = com.sunpride.field.storage.ActivityRules.missing(checklist)
    val review = controller.endReview
    val result = if (checkedOut) controller.visitResult(visit) else null
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(visit.outlet, style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("diagnostic-title"))
            Text(listOfNotNull(visit.planned.takeUnless { it == "Scheduled" },
                when { checkedOut -> "Done"; checkedIn -> "In progress"; else -> "Not started" }).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            // AND-013: the visit's purposes drive which activity forms the backend rules require.
            if (checkedIn || visit.plannedVisitId != null) {
                if (intents.isNotEmpty()) Text("Purpose · " + intents.joinToString(", ") {
                    com.sunpride.field.storage.ActivityRules.intentLabel(it) },
                    style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("visit-intents"))
            } else SectionCard("Visit purpose") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Choose one or more", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    com.sunpride.field.storage.ActivityRules.INTENTS.forEach { intent ->
                        ChoiceRow(com.sunpride.field.storage.ActivityRules.intentLabel(intent), intent in intents,
                            { controller.toggleIntent(intent) }, Modifier.testTag("intent-$intent"), !controller.busy)
                    }
                }
            }
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
            if (checkedIn && !checkedOut && checklist.isNotEmpty()) SectionCard("Activities") {
                checklist.forEach { item ->
                    val label = com.sunpride.field.storage.ActivityRules.kindLabel(item.kind)
                    val meta = when (item.status) {
                        com.sunpride.field.storage.ActivityRequirement.Status.DONE -> "Recorded"
                        com.sunpride.field.storage.ActivityRequirement.Status.UNAVAILABLE ->
                            "Not available on this phone" + if (item.required) " · office will review" else ""
                        else -> if (item.required) "Required" else "Optional"
                    }
                    val open: (() -> Unit)? = when {
                        item.status == com.sunpride.field.storage.ActivityRequirement.Status.UNAVAILABLE -> null
                        item.kind == "note" -> null // the Note card below
                        item.kind == "call_sheet" -> { { controller.openCallSheet() } }
                        else -> { { controller.openActivityForm(item.kind) } }
                    }
                    ListRow(label, meta, "activity", Modifier.testTag("activity-${item.kind}"),
                        trailing = if (item.status == com.sunpride.field.storage.ActivityRequirement.Status.DONE) "✓" else null,
                        onClick = open)
                }
            }
            // AND-016: photos belong to the open call; after End they stay listed until uploaded.
            val photos = controller.diagnosticPhotos
            if (checkedIn && (!checkedOut || photos.isNotEmpty())) SectionCard("Photos · ${photos.size}",
                Modifier.testTag("visit-photos")) {
                Column {
                    photos.forEach { photo ->
                        ListRow(com.sunpride.field.storage.EvidencePhotos.label(photo.photoType, controller.diagnosticPhotoTypes),
                            com.sunpride.field.storage.EvidencePhotos.stateLabel(photo), "photo",
                            Modifier.semantics(mergeDescendants = true) {}.testTag("visit-photo"))
                    }
                    if (!checkedOut) ListRow("Take photo", "Store front, shelf, price tags and more", "photo",
                        Modifier.testTag("photo-open"), onClick = { controller.openPhotoCapture() })
                }
            }
            if (checkedIn && !checkedOut) {
                SectionCard("Call sheet") {
                    if (controller.diagnosticCallSheet == null) Text(
                        "No call sheet set up for this account yet. Ask your office.",
                        Modifier.padding(16.dp).testTag("call-sheet-unavailable"),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else ListRow("Call sheet", "Record quantities for this visit", "activity",
                        Modifier.testTag("call-sheet-open"), onClick = { controller.openCallSheet() })
                }
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
                        androidx.compose.material3.Surface(onClick = { outcome = if (outcome == "completed") "nonproductive" else "completed"; controller.cancelEnd() },
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
            if (checkedIn && !checkedOut && outcome == "completed" && missing.isNotEmpty()) Text(
                "Still required: " + missing.joinToString(", ") { com.sunpride.field.storage.ActivityRules.kindLabel(it) },
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("activities-missing"))
            if (checkedIn && !checkedOut && outcome == "nonproductive") SectionCard("Nonproductive reason") {
                LabeledField("Reason code", reasonCode, { reasonCode = it; controller.cancelEnd() },
                    Modifier.fillMaxWidth().padding(16.dp).testTag("diagnostic-reason"))
            }
            // AND-017: confirm what End records; once queued the call cannot change on this phone.
            if (checkedIn && !checkedOut && review != null) SectionCard("Review and end", Modifier.testTag("end-review")) {
                Column {
                    com.sunpride.field.ui.ValueRow("Outcome", listOfNotNull(
                        com.sunpride.field.storage.VisitCompletion.outcomeLabel(review.outcome), review.reasonCode)
                        .joinToString(" · "), Modifier.semantics(mergeDescendants = true) {}.testTag("end-review-outcome"))
                    com.sunpride.field.ui.ValueRow("Time so far", "${review.minutes ?: 0} min")
                    com.sunpride.field.ui.ValueRow("Activities", review.recorded.takeIf { it.isNotEmpty() }
                        ?.joinToString(", ") { com.sunpride.field.storage.ActivityRules.kindLabel(it) } ?: "None recorded",
                        Modifier.semantics(mergeDescendants = true) {}.testTag("end-review-activities"))
                    if (review.officeReview.isNotEmpty()) com.sunpride.field.ui.ValueRow("Office will review",
                        review.officeReview.joinToString(", ") { com.sunpride.field.storage.ActivityRules.kindLabel(it) },
                        Modifier.semantics(mergeDescendants = true) {}.testTag("end-review-office"))
                    Text("Your location is recorded when you confirm. You can't change this call after it ends.",
                        Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (checkedOut) SectionCard("Done", Modifier.testTag("visit-result")) {
                Column {
                    result?.let { r ->
                        com.sunpride.field.ui.ValueRow("Outcome", listOfNotNull(
                            com.sunpride.field.storage.VisitCompletion.outcomeLabel(r.outcome), r.reasonCode)
                            .joinToString(" · "), Modifier.semantics(mergeDescendants = true) {}.testTag("result-outcome"))
                        com.sunpride.field.ui.ValueRow("Activities", r.recorded.takeIf { it.isNotEmpty() }
                            ?.joinToString(", ") { com.sunpride.field.storage.ActivityRules.kindLabel(it) } ?: "None recorded",
                            Modifier.semantics(mergeDescendants = true) {}.testTag("result-activities"))
                        if (r.officeReview.isNotEmpty()) com.sunpride.field.ui.ValueRow("Office will review",
                            r.officeReview.joinToString(", ") { com.sunpride.field.storage.ActivityRules.kindLabel(it) },
                            Modifier.semantics(mergeDescendants = true) {}.testTag("result-office"))
                        com.sunpride.field.ui.ValueRow("Sync", r.sync, Modifier.semantics(mergeDescendants = true) {}.testTag("result-sync"))
                        com.sunpride.field.storage.EvidencePhotos.summary(controller.diagnosticPhotos)?.let {
                            com.sunpride.field.ui.ValueRow("Photos", it,
                                Modifier.semantics(mergeDescendants = true) {}.testTag("result-photos"))
                        }
                        Text(r.location, Modifier.padding(horizontal = 16.dp, vertical = 10.dp)
                            .testTag(if (r.locationReview) "result-location-review" else "result-location"),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text("Visit saved · ${com.sunpride.field.storage.VisitCallRules.timeSpent(related) ?: "0 min"}",
                        Modifier.padding(16.dp).testTag("call-time-spent"))
                }
            }
            if (!checkedIn) startFailure?.let {
                Text(it.code.text, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("start-blocked"))
            }
            if (related.isNotEmpty()) SectionCard("Activity · ${related.size}") {
                related.forEach { (intent, state) ->
                    ListRow(when (intent.kind) {
                        "visit.checkIn" -> "Start"; "visit.activity" ->
                            com.sunpride.field.storage.ActivityRules.kindLabel(JSONObject(intent.serializedOperation)
                                .getJSONObject("payload").getJSONObject("activity").optString("kind"));
                        "visit.checkOut" -> "End call"; else -> "Visit action"
                    }, when (state) { "pending" -> "Waiting"; "done" -> "Accepted"; else -> "Needs review" },
                        "activity", Modifier.testTag("diagnostic-operation"))
                }
            }
            locationNotice?.let { Text(it.text, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag(if (it.review) "location-review" else "location-recorded")) }
            controller.diagnosticError?.let { Text(it, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag("queue-error")) }
            androidx.compose.foundation.layout.Spacer(Modifier.height(16.dp).testTag("visit-bottom-space"))
        }
        if (!checkedOut) androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        if (!checkedIn) PrimaryBottomButton("Start", { record("visit.checkIn") }, Modifier.testTag("diagnostic-checkin"),
            !controller.busy && !capturing && startFailure == null &&
                (visit.plannedVisitId != null || (reason.isNotBlank() && intents.isNotEmpty())))
        else if (!checkedOut && review != null) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            com.sunpride.field.ui.SecondaryButton("Back", { controller.cancelEnd() },
                Modifier.weight(1f).testTag("end-review-back"), enabled = !controller.busy && !capturing)
            androidx.compose.foundation.layout.Box(Modifier.weight(2f)) {
                PrimaryBottomButton("Confirm end", { record("visit.checkOut") }, Modifier.testTag("diagnostic-confirm-end"),
                    !controller.busy && !capturing)
            }
        }
        else if (!checkedOut) PrimaryBottomButton("End call", { controller.reviewEnd(outcome, reasonCode) },
            Modifier.testTag("diagnostic-checkout"), !controller.busy && !capturing && outcome != null &&
                (outcome != "nonproductive" || reasonCode.isNotBlank()) && (outcome != "completed" || missing.isEmpty()))
    }
}
