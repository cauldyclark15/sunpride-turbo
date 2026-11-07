package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sunpride.van.pos.*
import com.sunpride.van.storepos.Supervisor
import org.json.JSONObject

/** IP-REFUND: what the refund sheet needs to know about the sale it takes items back from. */
data class RefundSheetModel(
    val receiptNumber: String,
    val customerName: String?,
    val receipt: JSONObject,
    val lines: List<SoldLine>,
    val prior: Map<Int, Long>,
    val policy: RefundPolicy,
    /** Plain words why nothing can be refunded (trip counted, sale voided...), else null. */
    val problem: String? = null,
    val refundNumber: Int = 1,
    /** Money this sale has already had refunded by item: counts toward the supervisor amount. */
    val refundedMinor: Long = 0L,
)

/** How a refund over the office amount is approved: a supervisor's PIN on the till, an 8-digit code read out on the van. */
enum class RefundApprovalKind { PIN, CODE }

/** What Confirm sends: everything the store needs to price and save the refund once. */
data class RefundSubmission(val picks: Map<Int, Long>, val reason: RefundReason, val note: String?, val expectedMinor: Long,
    val supervisor: Supervisor?, val pin: String, val code: String)

private fun pesos(minor: Long) = PosMoney.format(minor, "PHP")

/**
 * IP-REFUND: choose the items and how many pieces come back, say why, and Confirm. Nothing is saved until Confirm; the +/- buttons
 * and the reason only choose. Above the office's amount a supervisor approves first. The price shown is the one the office will
 * freeze (same maths as the credit memo), so the cashier sees exactly what goes back to the customer.
 */
@Composable fun RefundSheet(model: RefundSheetModel, approval: RefundApprovalKind, supervisors: List<Supervisor>, busy: Boolean, error: String?,
    onConfirm: (RefundSubmission) -> Unit, onClose: () -> Unit) {
    var picks by remember(model.receiptNumber) { mutableStateOf(emptyMap<Int, Long>()) }
    var reasonCode by remember(model.receiptNumber) { mutableStateOf<String?>(null) }
    var note by remember(model.receiptNumber) { mutableStateOf("") }
    var supervisor by remember { mutableStateOf<Supervisor?>(null) }
    var pin by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    val chosen = picks.filterValues { it > 0L }
    // The PIN pad appears under the supervisor names, below the footer's edge: bring it into view once a supervisor is picked.
    val listState = androidx.compose.foundation.lazy.rememberLazyListState()
    LaunchedEffect(supervisor?.profileId) { if (supervisor != null) { withFrameNanos { }; withFrameNanos { }; listState.animateScrollToItem(maxOf(0, listState.layoutInfo.totalItemsCount - 1)); listState.scrollBy(100_000f) } }
    val planResult = remember(chosen, model) { if (chosen.isEmpty()) null else runCatching { RefundMath.plan(model.receipt, model.prior, chosen) } }
    val plan = planResult?.getOrNull()
    // A plan that cannot be priced is said in words, never left as a button that does nothing.
    val planProblem = planResult?.exceptionOrNull()?.let { e -> (e as? RefundRefused)?.message?.takeIf { it.isNotBlank() } ?: "These items cannot be refunded as chosen. Check the pieces and try again." }
    var clickError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(chosen, reasonCode) { clickError = null }
    val total = plan?.totalMinor ?: 0L
    val reason = model.policy.reason(reasonCode)
    val needsApproval = plan != null && RefundMath.needsSupervisor(total, model.policy.supervisorOverMinor, model.refundedMinor)
    val approved = when (approval) {
        RefundApprovalKind.PIN -> supervisor != null && pin.length >= 6
        RefundApprovalKind.CODE -> VoidApprovalCodes.normalize(code) != null
    }
    val problem = model.problem ?: planProblem ?: RefundForm.problem(chosen, reason, note, needsApproval, approved)
    // Whatever went wrong while saving is shown here, in the footer next to Confirm, so a long list never hides it off the bottom.
    val shownError = error ?: clickError
    LookSheet("Refund items", onClose, tag = "refund-sheet", fill = true, closeTag = "refund-close", footer = {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.widthIn(min = 72.dp)) {
                Text("Refund", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Look.ink)
                Text(if (chosen.isEmpty()) "Nothing chosen" else "${chosen.values.sum()} to go back", fontSize = 14.sp, color = Look.muted, maxLines = 1)
            }
            FitText(pesos(total), 44.sp, Modifier.weight(1f), minSize = 24.sp, color = Look.ink, textAlign = TextAlign.End, tag = "refund-total")
        }
        shownError?.let { Text(it, Modifier.fillMaxWidth().testTag("refund-error"), fontSize = 16.sp, fontWeight = FontWeight.Bold, color = SunprideTokens.emptyRed, textAlign = TextAlign.Center) }
        problem?.let { Text(it, Modifier.fillMaxWidth().testTag("refund-problem"), fontSize = 14.sp, color = Look.muted, textAlign = TextAlign.Center) }
        PillButton(if (busy) "Saving…" else "Confirm refund", {
            if (plan != null && reason != null) { clickError = null; onConfirm(RefundSubmission(chosen, reason, note.trim().takeIf { it.isNotEmpty() }, total, supervisor.takeIf { needsApproval && approval == RefundApprovalKind.PIN }, pin, if (needsApproval && approval == RefundApprovalKind.CODE) code else "")) }
            else clickError = "Choose the items and why, then try again."
        }, Modifier.testTag("refund-confirm"), enabled = problem == null && !busy, height = 64.dp, fontSize = 22.sp)
    }) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("refund-lines"), state = listState, contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Receipt ${model.receiptNumber}", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = Look.ink, modifier = Modifier.testTag("refund-receipt"))
                    model.customerName?.takeIf { it.isNotBlank() }?.let { Text(it, fontSize = 15.sp, color = Look.muted) }
                    Text("Choose how many pieces the customer is returning. Prices include any discount they got.", fontSize = 14.sp, color = Look.muted)
                }
            }
            model.problem?.let { p -> item { Text(p, Modifier.testTag("refund-blocked"), fontSize = 16.sp, fontWeight = FontWeight.SemiBold, color = SunprideTokens.emptyRed) } }
            items(model.lines, key = { it.index }) { line ->
                val done = model.prior[line.index] ?: 0L
                val left = maxOf(0L, line.quantityBase - done)
                val now = picks[line.index] ?: 0L
                val each = if (line.quantityBase > 0) RefundMath.share(line.payableMinor, done, now, line.quantityBase) else 0L
                Surface(Modifier.fillMaxWidth().testTag("refund-line-${line.index}"), shape = RoundedCornerShape(Look.cardRadius), color = if (now > 0) Look.tint else Look.card,
                    border = BorderStroke(1.dp, Look.hairline)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(line.name, fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold)
                                Text(buildString {
                                    append("Sold ${line.quantityBase}")
                                    if (done > 0) append(" · already refunded $done")
                                    append(" · ${pesos(line.payableMinor)}")
                                }, fontSize = 14.sp, color = Look.muted, modifier = Modifier.testTag("refund-line-${line.index}-sold"))
                            }
                            if (now > 0) Text(pesos(each), fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = Look.accent, modifier = Modifier.testTag("refund-line-${line.index}-amount"))
                        }
                        if (left == 0L) Text("All refunded", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Look.muted, modifier = Modifier.testTag("refund-line-${line.index}-none"))
                        else QtyStepper(now.toString(), { picks = picks + (line.index to maxOf(0L, now - 1)) }, { picks = picks + (line.index to minOf(left, now + 1)) }, null, "refund-line-${line.index}",
                            plusEnabled = now < left)
                    }
                }
            }
            item { Text("Why is it coming back?", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Look.ink, modifier = Modifier.padding(top = 6.dp)) }
            items(model.policy.reasons, key = { it.code }) { r ->
                val on = r.code == reasonCode
                OutlinedButton({ reasonCode = r.code }, Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("refund-reason-${r.code}"), shape = RoundedCornerShape(Look.pill),
                    colors = if (on) ButtonDefaults.outlinedButtonColors(containerColor = Look.accent, contentColor = Look.onAccent) else ButtonDefaults.outlinedButtonColors(containerColor = Look.sheet, contentColor = Look.ink)) {
                    Column(Modifier.weight(1f)) {
                        Text(r.label, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, textAlign = TextAlign.Start)
                        if (r.damaged) Text("Goes to damaged stock", fontSize = 13.sp, color = if (on) Look.onAccent else Look.muted)
                    }
                }
            }
            if (reason?.requiresNote == true || note.isNotEmpty() || reason != null) item {
                LabeledField(if (reason?.requiresNote == true) "Write why (needed)" else "Note (optional)", note, { note = it }, "refund-note", maxLength = 300)
            }
            if (needsApproval) item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(if (model.refundedMinor > 0L) "With the ${pesos(model.refundedMinor)} already refunded on this receipt, this is over ${pesos(model.policy.supervisorOverMinor)}, so a supervisor has to approve it." else "This refund is over ${pesos(model.policy.supervisorOverMinor)}, so a supervisor has to approve it.", fontSize = 15.sp, color = Look.ink, modifier = Modifier.testTag("refund-needs-approval"))
                    when (approval) {
                        RefundApprovalKind.PIN -> SupervisorPinBlock(supervisors, supervisor, { supervisor = it }, pin, { pin = it }, null, !busy)
                        RefundApprovalKind.CODE -> {
                            Text("Refund number ${model.refundNumber} of this receipt. Ask your supervisor to get an 8-digit code from the office screen for this receipt, amount and reason.", fontSize = 14.sp, color = Look.muted)
                            LabeledField("Supervisor code", code, { code = it }, "refund-code", numeric = true, maxLength = 9)
                        }
                    }
                }
            }
        }
    }
}

/** After Confirm: the refund is saved on this phone. The slip prints by itself; this lets the cashier print it again before moving on. */
@Composable fun RefundDoneDialog(creditNumber: String, receiptNumber: String, totalMinor: Long, cashMinor: Long, damaged: Boolean, printMessage: String?, printing: Boolean,
    onPrint: () -> Unit, onDone: () -> Unit) {
    LookSheet("Refund saved", onDone, tag = "refund-done", dismissible = false, footer = {
        PillButton("Print refund slip again", onPrint, Modifier.testTag("refund-print"), enabled = !printing, filled = false, height = 56.dp)
        PillButton("Done", onDone, Modifier.testTag("refund-done-button"), height = 64.dp, fontSize = 22.sp)
    }) {
        Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(pesos(totalMinor), fontSize = 40.sp, fontWeight = FontWeight.ExtraBold, color = Look.ink, modifier = Modifier.testTag("refund-done-total"))
            Text("Credit memo $creditNumber", fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.testTag("refund-done-number"))
            Text("Takes back receipt $receiptNumber", fontSize = 15.sp, color = Look.muted)
            if (cashMinor > 0) Text("Give the customer ${pesos(cashMinor)} in cash.", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("refund-done-cash"))
            if (totalMinor - cashMinor > 0) Text("${pesos(totalMinor - cashMinor)} goes back by the way they paid.", fontSize = 15.sp)
            if (damaged) Text("The goods were set aside as damaged stock.", fontSize = 15.sp, color = Look.muted)
            Text(printMessage ?: "Printing…", fontSize = 15.sp, color = Look.muted, modifier = Modifier.testTag("refund-print-status"))
        }
    }
}
