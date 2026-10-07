package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import com.sunpride.van.pos.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * VAN-024 Close trip: the checklist read from this phone, the open exceptions to confirm, and an optional end
 * odometer and note. Close trip is enabled only when nothing blocks and, per policy, the exceptions are confirmed;
 * the store checks everything again while saving.
 */
@Composable fun CloseTripScreen(c: VanController) {
    val summary = c.closeSummary
    val saved = summary?.saved
    val draft = c.closeDraft
    val policy = TripCloseRules.policy(c.policy)
    val checklist = summary?.checklist
    val km = draft.odometer.takeIf { it.isNotBlank() }?.trim()?.toDoubleOrNull()
    val odometerValid = draft.odometer.isBlank() || TripCloseRules.validOdometer(km ?: Double.NaN,summary?.startOdometerKm)
    val noteValid = TripCloseRules.validNote(draft.note)
    val needsReview = checklist != null && TripCloseRules.needsReview(checklist,policy)
    val ready = summary != null && saved == null && checklist!!.ready && odometerValid && noteValid && (!needsReview || draft.reviewed)

    ScreenFrame("Close trip",c::back,
        action = if (saved != null) "Done" else if (c.busy) "Closing…" else "Close trip",actionTag = "close-trip",
        enabled = if (saved != null) true else ready && !c.busy,
        onAction = { if (saved != null) c.back() else c.closeTrip() },
        footer = if (saved == null && checklist != null) "${checklist.blockers.size} to do · ${checklist.exceptions.size} to check" else null,
        message = c.message) {
        when {
            summary == null -> Text("Getting this trip's checks…")
            saved != null -> SavedClose(saved)
            else -> {
                Text("Trip ${summary.tripNumber}",style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("close-trip-number"))
                SectionCard("Before you close") {
                    checklist!!.steps.forEach { step ->
                        val mark = if (step.done) "✓" else if (step.required) "✗" else "–"
                        Text("$mark ${VanRules.closeStepLabel(step)}",style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.testTag("close-step-${step.step.name.lowercase()}"))
                    }
                    val blocked = checklist.blockers.map { it.step }.toSet()
                    if (CloseStep.CASH_COUNTED in blocked) SecondaryButton("Count cash",{ c.open(Page.CASH) },Modifier.testTag("close-go-cash"),!c.busy)
                    if (CloseStep.STOCK_COUNTED in blocked) SecondaryButton("Count stock",{ c.open(Page.STOCK_COUNT) },Modifier.testTag("close-go-stock"),!c.busy)
                    if (CloseStep.UPLOADS_SENT in blocked || CloseStep.PHONE_ACTIVE in blocked) SecondaryButton("Sync now",c::syncForClose,Modifier.testTag("close-sync"),!c.busy)
                }
                SectionCard("Check these") {
                    if (checklist!!.exceptions.isEmpty()) Text("Nothing to check",modifier = Modifier.testTag("close-no-exceptions"))
                    checklist.exceptions.forEach { e ->
                        Text(VanRules.closeExceptionLabel(e,c.cashSummary?.expectation?.currency ?: "PHP"),style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.testTag("close-exception-${e.kind.wire}"))
                    }
                    if (checklist.exceptions.any { it.kind == CloseExceptionKind.UNPRINTED_RECEIPTS })
                        SecondaryButton("Open receipts",{ c.open(Page.RECEIPTS) },Modifier.testTag("close-go-receipts"),!c.busy)
                    if (needsReview) Confirmation("I have checked these with my supervisor",draft.reviewed,
                        { c.editClose(draft.copy(reviewed = it)) },"close-reviewed")
                }
                LabeledField("End odometer km (optional)",draft.odometer,{ c.editClose(draft.copy(odometer = it)) },"close-odometer",
                    numeric = true,maxLength = 20,keyboardType = KeyboardType.Decimal,enabled = !c.busy)
                summary.startOdometerKm?.let { Text("At start: ${VanRules.km(it)} km",style = MaterialTheme.typography.bodyMedium) }
                if (!odometerValid) Text("Enter the end odometer in km, not lower than at the start.",Modifier.testTag("close-odometer-invalid"))
                LabeledField("Note (optional)",draft.note,{ c.editClose(draft.copy(note = it)) },"close-note",enabled = !c.busy,maxLength = 300)
                Text("After closing, this trip takes no more sales, voids, returns, damage or counts on this phone.",style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable private fun SavedClose(saved: TripCloseResult) {
    SectionCard("Trip closed") {
        Text("Closed on this phone",style = MaterialTheme.typography.headlineSmall,modifier = Modifier.testTag("close-saved"))
        Text("Trip ${saved.tripNumber} · ${Instant.ofEpochMilli(saved.createdAt).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d, h:mm a"))}")
        Text("${saved.operationCount} ${if (saved.operationCount == 1) "record" else "records"} from this trip saved for the office",
            modifier = Modifier.testTag("close-saved-records"))
        saved.endOdometerKm?.let { Text("End odometer: ${VanRules.km(it)} km") }
        saved.note?.let { Text("Note: $it") }
    }
    SectionCard("Checked at close") {
        if (saved.exceptions.isEmpty()) Text("Nothing to check",modifier = Modifier.testTag("close-saved-no-exceptions"))
        saved.exceptions.forEach { Text(VanRules.closeExceptionLabel(it)) }
        if (saved.reviewed) Text("Checked with supervisor",modifier = Modifier.testTag("close-saved-reviewed"))
    }
    Text("Hand the cash and the truck to the office. Receipts can still be reprinted.",style = MaterialTheme.typography.bodyMedium)
}
