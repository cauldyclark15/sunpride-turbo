package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sunpride.van.pos.*

/**
 * VAN-022 Count cash: the cash the phone expects from this trip's saved sales, a bill-and-coin count, the
 * difference, its reason and (above the office tolerance) the supervisor's code. Once saved it shows the result
 * and the trip sells nothing more.
 */
@Composable fun CashCountScreen(c: VanController) {
    val summary = c.cashSummary
    val saved = summary?.saved
    val draft = c.cashDraft
    val currency = summary?.expectation?.currency ?: "PHP"
    val counts = draft.pieces.mapValues { (_, text) -> CashReconciliationRules.parsePieces(text) }
    val countValid = counts.values.none { it == null }
    val declared = if (countValid) CashReconciliationRules.declared(counts.mapValues { it.value!! }) else null
    val expected = summary?.expectation?.expectedMinor
    val variance = if (declared != null && expected != null) declared - expected else null
    val needsApproval = variance != null && CashReconciliationRules.needsApproval(c.policy,variance)
    val unavailable = needsApproval && c.policy?.cashReconciliation?.key == null
    val reasons = CashVarianceReasons.offered(c.policy)
    val noteValid = draft.note.length <= 300 && draft.note.none(Char::isISOControl) && (draft.reasonCode != "other" || draft.note.isNotBlank())
    val ready = summary != null && summary.countable && saved == null && variance != null &&
        (variance == 0L || (draft.reasonCode in reasons.map { it.code } && noteValid && !unavailable &&
            (!needsApproval || VoidApprovalCodes.normalize(draft.code) != null)))
    // Amounts and reason are bound into the supervisor code: changing either discards a typed code.
    fun edit(next: CashDraft, rebinds: Boolean) = c.editCash(if (rebinds) next.copy(code = "") else next)
    ScreenFrame("Count cash",c::back,
        action = if (saved != null) "Done" else if (c.busy) "Saving…" else "Save cash count",actionTag = "save-cash",
        enabled = if (saved != null) true else ready && !c.busy,
        onAction = { if (saved != null) c.back() else expected?.let(c::saveCashCount) },
        footer = if (saved == null && expected != null) "Counted ${declared?.let { PosMoney.format(it,currency) } ?: "—"} · expected ${PosMoney.format(expected,currency)}" else null,
        message = c.message) {
        when {
            summary == null -> Text("Getting this trip's sales…")
            saved != null -> SavedCount(saved,summary.tripNumber)
            !summary.countable -> Text("Start the trip before counting cash.",Modifier.testTag("cash-blocked"))
            else -> {
                val e = summary.expectation
                SectionCard("Expected cash") {
                    Text(PosMoney.format(e.expectedMinor,e.currency),style = MaterialTheme.typography.headlineMedium,modifier = Modifier.testTag("cash-expected"))
                    Text("${e.cashSales} cash ${if (e.cashSales == 1) "sale" else "sales"} on this phone" +
                        (if (e.voidedSales > 0) " · ${e.voidedSales} voided left out" else ""),style = MaterialTheme.typography.bodyMedium)
                    if (e.others.isNotEmpty()) {
                        Text("Not in the cash bag",style = MaterialTheme.typography.titleMedium)
                        e.others.forEach { m -> Text("${m.label} · ${m.count} ${if (m.count == 1) "sale" else "sales"} · ${PosMoney.format(m.amountMinor,e.currency)}",
                            style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("cash-other-${m.code}")) }
                    }
                }
                SectionCard("Count bills and coins") {
                    Text("Count only cash from today's sales. Leave out your change fund.",style = MaterialTheme.typography.bodyMedium)
                    CashDenominations.PHP.forEach { denomination ->
                        val text = draft.pieces[denomination.minor] ?: ""
                        val pieces = CashReconciliationRules.parsePieces(text)
                        Row(Modifier.fillMaxWidth(),verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Text(denomination.label,Modifier.width(72.dp),style = MaterialTheme.typography.titleMedium)
                            Box(Modifier.weight(1f)) {
                                LabeledField("Pieces",text,{ value -> edit(draft.copy(pieces = draft.pieces + (denomination.minor to value)),true) },
                                    "pieces-${denomination.minor}",enabled = !c.busy,maxLength = 6,keyboardType = KeyboardType.Number)
                            }
                            Text(pieces?.let { PosMoney.format(Math.multiplyExact(it,denomination.minor),currency) } ?: "Whole number",
                                Modifier.width(104.dp),style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
                SectionCard("Difference") {
                    Text(when { !countValid -> "Enter whole numbers of bills and coins."; variance == null -> "—"; else -> VanRules.varianceLabel(variance,currency) },
                        style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("cash-variance"))
                    if (variance != null && variance != 0L) {
                        Text("Why is the cash different?",style = MaterialTheme.typography.bodyMedium)
                        reasons.forEach { option ->
                            Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(draft.reasonCode == option.code,enabled = !c.busy,
                                onClick = { edit(draft.copy(reasonCode = option.code),draft.reasonCode != option.code) },role = Role.RadioButton)
                                .testTag("cash-reason-${option.code}"),verticalAlignment = Alignment.CenterVertically) {
                                RadioButton(draft.reasonCode == option.code,onClick = null,colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
                                Text(option.label,Modifier.weight(1f).padding(start = 8.dp),style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                        LabeledField(if (draft.reasonCode == "other") "Note (required)" else "Note (optional)",draft.note,{ edit(draft.copy(note = it),false) },
                            "cash-note",enabled = !c.busy,maxLength = 300)
                        if (needsApproval) {
                            Text("Supervisor approval",style = MaterialTheme.typography.titleMedium)
                            if (unavailable) Text("Supervisor approval is not set up on this phone. Sync, then try again.",Modifier.testTag("cash-approval-unavailable"))
                            else {
                                Text("Call your supervisor. Read them: trip ${summary.tripNumber}, expected ${PosMoney.format(e.expectedMinor,currency)}, " +
                                    "counted ${PosMoney.format(declared!!,currency)}, reason ${draft.reasonCode?.let(CashVarianceReasons::label) ?: "(choose one)"}. Type the 8-digit code they give you.",
                                    style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("cash-approval-script"))
                                LabeledField("8-digit code",draft.code,{ edit(draft.copy(code = it),false) },"cash-code",enabled = !c.busy,maxLength = 20,keyboardType = KeyboardType.Number)
                            }
                        }
                    }
                }
                Text("After saving, this trip takes no more sales or voids.",style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable private fun SavedCount(saved: CashCountResult, tripNumber: String) {
    SectionCard("Cash count saved") {
        Text(VanRules.varianceLabel(saved.varianceMinor,saved.currency),style = MaterialTheme.typography.headlineMedium,modifier = Modifier.testTag("cash-saved-variance"))
        Text("Trip $tripNumber")
        Text("Expected ${PosMoney.format(saved.expectedMinor,saved.currency)} · counted ${PosMoney.format(saved.declaredMinor,saved.currency)}",
            modifier = Modifier.testTag("cash-saved-amounts"))
        saved.reasonCode?.let { Text("Reason: ${CashVarianceReasons.label(it)}") }
        saved.note?.let { Text("Note: $it") }
        if (saved.approved) Text("Approved by your supervisor",modifier = Modifier.testTag("cash-saved-approved"))
        Text("Hand the cash to the cashier. This trip takes no more sales.",style = MaterialTheme.typography.bodyMedium)
    }
    SectionCard("Bills and coins") {
        val counted = CashDenominations.PHP.filter { (saved.counts[it.minor] ?: 0L) > 0 }
        if (counted.isEmpty()) Text("No cash")
        counted.forEach { d -> val n = saved.counts.getValue(d.minor)
            Text("${d.label} × $n = ${PosMoney.format(Math.multiplyExact(n,d.minor),saved.currency)}") }
    }
}
