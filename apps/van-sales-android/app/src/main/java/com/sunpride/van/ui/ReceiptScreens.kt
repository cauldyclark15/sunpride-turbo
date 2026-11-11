package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.text.input.KeyboardType
import com.sunpride.van.data.VanPolicy
import com.sunpride.van.pos.*
import com.sunpride.van.printing.ReprintRules
import com.sunpride.van.storage.SavedSale
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * VAN-017 receipts. A sale prints once as the original; every further copy is an explicit Reprint with a reason,
 * limited per sale and marked REPRINT on paper. Printing never changes the saved sale.
 */
@Composable fun ReceiptPrintCard(c: VanController, saleId: String) {
    val saved = c.savedSales.firstOrNull { it.receipt.saleId == saleId }
    var reprinting by remember { mutableStateOf<SavedSale?>(null) }
    SectionCard("Receipt") {
        Text(c.printMessage ?: when {
            saved == null -> "Getting the receipt…"
            saved.void != null -> if (saved.voidSlipPrinted) "Void slip printed." else "Void slip not printed yet."
            saved.confirmed -> "Printed."
            saved.needsConfirmation -> "Sent to the printer. Did it print?"
            saved.skipped -> "Not printed (skipped, no paper)."
            else -> "Not printed yet."
        },style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("print-status"))
        saved?.let { FiscalPreviewButtons(it) }
        PrintButtons(c,saved,"sale") { reprinting = it }
    }
    reprinting?.let { ReprintDialog(it,onPrint = { reason -> c.printReceipt(it.receipt.saleId,reason); reprinting = null },onClose = { reprinting = null }) }
}

@Composable private fun PrintButtons(c: VanController, saved: SavedSale?, tag: String, onReprint: (SavedSale) -> Unit) {
    if (saved == null) return
    when {
        saved.void != null -> {
            if (saved.voidSlipsLeft > 0) SecondaryButton(if (c.printing) "Printing…" else if (saved.voidSlipPrinted) "Reprint void slip" else "Print void slip",
                { c.printReceipt(saved.receipt.saleId) },Modifier.testTag(if (saved.voidSlipPrinted) "$tag-reprint" else "$tag-print"),enabled = !c.printing)
            else Text("No more void slips on this phone. Ask the office for a copy.",modifier = Modifier.testTag("$tag-reprint-limit"))
        }
        // Sent but not answered: ask "Did it print?" before anything else; a re-send stays the original.
        saved.needsConfirmation -> SecondaryButton("Did it print?",{ c.askDidItPrint(saved.receipt.saleId,false) },
            Modifier.testTag("$tag-did-it-print"),enabled = !c.printing)
        !saved.confirmed -> SecondaryButton(if (c.printing) "Printing…" else "Print receipt",{ c.printReceipt(saved.receipt.saleId) },
            Modifier.testTag("$tag-print"),enabled = !c.printing)
        saved.reprintsLeft > 0 -> SecondaryButton(if (c.printing) "Printing…" else "Reprint",{ onReprint(saved) },
            Modifier.testTag("$tag-reprint"),enabled = !c.printing)
        else -> Text("Reprinted ${ReprintRules.MAX_REPRINTS} times. Ask the office for a copy.",style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("$tag-reprint-limit"))
    }
}

@Composable fun ReceiptsScreen(c: VanController) {
    var reprinting by remember { mutableStateOf<SavedSale?>(null) }
    var voiding by remember { mutableStateOf<SavedSale?>(null) }
    var collecting by remember { mutableStateOf<SavedSale?>(null) }
    val time = remember { DateTimeFormatter.ofPattern("h:mm a") }
    LaunchedEffect(c.savedSales.size) { c.refreshRefunds() }
    ScreenFrame("Receipts",message = c.message ?: c.printMessage,trailing = { SyncPill(c) }) {
        if (c.savedSales.isEmpty()) {
            EmptyState(GlyphKind.RECEIPT,"No receipts yet","Sales you complete on this trip show up here, so you can print or reprint them.",Modifier.testTag("no-receipts"),
                actionLabel = if (VanRules.canSell(c.trip) && !c.tripClosed) "Start a sale" else null,onAction = { c.open(Page.CUSTOMERS) },actionTag = "receipts-start-sale")
        } else Text("After you confirm the first print, any further copy is marked REPRINT. Voided sales print only VOID slips.",style = MaterialTheme.typography.bodyMedium)
        c.savedSales.forEachIndexed { index, saved ->
            val r = saved.receipt
            SectionCard(Instant.ofEpochMilli(r.createdAt).atZone(ZoneId.systemDefault()).format(time)) {
                Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(r.customerName,Modifier.weight(1f),style = MaterialTheme.typography.titleMedium)
                    Text(PosMoney.format(r.totalMinor,r.currency),style = MaterialTheme.typography.titleMedium,fontWeight = FontWeight.SemiBold)
                }
                Text(r.receiptNumber,style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("receipt-$index-number"))
                val reprints = saved.prints.count { it.confirmed && it.kind == com.sunpride.van.printing.PrintKind.REPRINT }
                Text(when {
                    saved.void != null -> if (saved.voidSlipPrinted) "Void slip printed · ${saved.voidSlipsLeft} copies left" else "Void slip not printed"
                    saved.needsConfirmation -> "Sent to printer · did it print?"
                    saved.skipped -> "Not printed · skipped, no paper"
                    !saved.confirmed -> "Not printed"
                    reprints == 0 -> "Printed · ${saved.reprintsLeft} reprints left"
                    else -> "Printed · reprinted $reprints× · ${saved.reprintsLeft} reprints left"
                },style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("receipt-$index-state"))
                saved.void?.let { Text("VOIDED · ${VoidReasons.label(it.reasonCode)}",style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.testTag("receipt-$index-void")) }
                FiscalPreviewButtons(saved)
                PrintButtons(c,saved,"receipt-$index") { reprinting = it }
                if (!saved.isCollection && saved.void == null && r.paymentKind == com.sunpride.van.data.PaymentKind.CREDIT && !c.tripClosed)
                    SecondaryButton("Collect payment & issue OR",{collecting=saved},Modifier.testTag("receipt-$index-collect"),enabled=!c.busy)
                c.refundsBySale[r.saleId]?.let { Text("Refunded ${PosMoney.format(it,r.currency)} · void is closed, refund the items that are left",style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("receipt-$index-refunded")) }
                if (!saved.isCollection && saved.void == null && !c.refundsBySale.containsKey(r.saleId) && c.policy?.let { VoidRules.offered(it).isNotEmpty() } == true)
                    DangerButton("Void sale",{ voiding = saved },Modifier.testTag("receipt-$index-void-sale"),enabled = !c.busy && !c.printing)
                // IP-REFUND: take back some of the items (opt-in from the office; older servers never send the reasons)
                if (!saved.isCollection && saved.void == null && r.paymentKind != com.sunpride.van.data.PaymentKind.CREDIT && c.policy?.refunds != null && !c.tripClosed)
                    SecondaryButton("Refund items",{ c.openRefund(r.saleId) },Modifier.testTag("receipt-$index-refund"),enabled = !c.busy && !c.printing)
            }
        }
    }
    c.refundModel?.let { m -> RefundSheet(m,RefundApprovalKind.CODE,emptyList(),c.busy,c.refundError,onConfirm = { c.confirmRefund(it) },onClose = c::cancelRefund) }
    c.refundDone?.let { d -> RefundDoneDialog(d.creditNumber,d.receiptNumber,d.plan.totalMinor,d.cashMinor,d.reason.damaged,c.printMessage,c.printing,onPrint = { c.printRefundSlip(d.refundId) },onDone = c::finishRefund) }
    reprinting?.let { ReprintDialog(it,onPrint = { reason -> c.printReceipt(it.receipt.saleId,reason); reprinting = null },onClose = { reprinting = null }) }
    collecting?.let { CollectionDialog(c,it,onClose={collecting=null}) }
    voiding?.let { saved -> c.policy?.let { policy ->
        var attempted by remember(saved.receipt.saleId) { mutableStateOf(false) }
        VoidSaleDialog(saved,policy,c.busy,error = c.message.takeIf { attempted && !c.busy },onVoid = { reason,note,code ->
            attempted = true
            c.voidSale(saved.receipt.saleId,reason,note,code) { voiding = null }
        },onClose = { voiding = null })
    } }
}

/** Reason first, then print. The copy number shown is the one that will be printed. */
@Composable fun ReprintDialog(saved: SavedSale, onPrint: (String) -> Unit, onClose: () -> Unit) {
    ReprintReasonDialog("${saved.receipt.customerName} · ${PosMoney.format(saved.receipt.totalMinor,saved.receipt.currency)}",
        ReprintRules.MAX_REPRINTS - saved.reprintsLeft + 1,onPrint,onClose)
}
@Composable fun ReprintReasonDialog(summary: String, copy: Int, onPrint: (String) -> Unit, onClose: () -> Unit) {
    var reason by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = onClose,properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().statusBarsPadding(),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Reprint receipt",style = MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(summary,style = MaterialTheme.typography.titleMedium)
                    Text("Copy $copy of ${ReprintRules.MAX_REPRINTS}. It prints marked REPRINT. Why?",style = MaterialTheme.typography.bodyMedium)
                    ReprintRules.REASONS.forEach { option ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(reason == option.code,onClick = { reason = option.code },role = Role.RadioButton)
                            .testTag("reprint-reason-${option.code}"),verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(reason == option.code,onClick = null,colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
                            Text(option.label,Modifier.weight(1f).padding(start = 8.dp),style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                }
                PrimaryBottomButton("Print copy $copy",{ reason?.let(onPrint) },enabled = reason != null,tag = "confirm-reprint")
                SecondaryButton("Cancel",onClose,Modifier.testTag("cancel-reprint"))
            }
        }
    }
}

/**
 * IP-P0 (SPEC 6.5): the H10P cannot see paper, so after every print the seller answers. Sent again before "Yes, printed"
 * is still the original; "Skip, no paper" records the receipt as unprinted for the office.
 */
@Composable fun DidItPrintSheet(c: VanController) {
    Dialog(onDismissRequest = c::dismissPrintQuestion,properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().statusBarsPadding(),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Did it print?",style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("print-question"))
                Text("The phone cannot see the paper. Look at the receipt. If nothing came out, print again.",style = MaterialTheme.typography.bodyLarge)
                c.printQuestionNote?.let { Text(it,style = MaterialTheme.typography.bodyLarge,fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold,modifier = Modifier.testTag("print-refused")) }
                PrimaryBottomButton("Yes, printed",c::answerPrinted,enabled = !c.printing,tag = "print-yes")
                SecondaryButton("Print again",c::answerPrintAgain,Modifier.testTag("print-again"),enabled = !c.printing)
                SecondaryButton("Skip, no paper",c::answerSkipped,Modifier.testTag("print-skip"),enabled = !c.printing)
            }
        }
    }
}

/** The supervisor code is tied to the selected reason. Changing it always discards an old code. */
@Composable fun VoidSaleDialog(saved: SavedSale, policy: VanPolicy, busy: Boolean = false, error: String? = null,
    onVoid: (String,String?,String?) -> Unit, onClose: () -> Unit) {
    var reason by remember { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf("") }
    var code by remember { mutableStateOf("") }
    val needsApproval = VoidRules.needsApproval(policy,saved.receipt.totalMinor)
    val unavailable = needsApproval && policy.voidApproval?.key == null
    val validNote = note.length <= 300 && note.none(Char::isISOControl) && (reason != "other" || note.isNotBlank())
    Dialog(onDismissRequest = { if (!busy) onClose() },properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().statusBarsPadding().imePadding(),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Void sale",style = MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${saved.receipt.customerName} · ${PosMoney.format(saved.receipt.totalMinor,saved.receipt.currency)}",style = MaterialTheme.typography.titleMedium)
                    Text(saved.receipt.receiptNumber,style = MaterialTheme.typography.bodyMedium)
                    Text("Why are you voiding this sale? The sale will not be deleted.",style = MaterialTheme.typography.bodyMedium)
                    VoidRules.offered(policy).forEach { option ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(reason == option.code,enabled = !busy,
                            onClick = { if (reason != option.code) { reason = option.code; code = "" } },role = Role.RadioButton)
                            .testTag("void-reason-${option.code}"),verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(reason == option.code,onClick = null,colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
                            Text(option.label,Modifier.weight(1f).padding(start = 8.dp),style = MaterialTheme.typography.bodyLarge)
                        }
                    }
                    LabeledField(if (reason == "other") "Note (required)" else "Note (optional)",note,{ note = it },"void-note",enabled = !busy,maxLength = 300)
                    if (needsApproval) {
                        Text("Supervisor approval",style = MaterialTheme.typography.titleMedium)
                        if (unavailable) Text("Supervisor approval is not set up on this phone. Sync, then try again.")
                        else {
                            Text("Call your supervisor. Read them the receipt number, the total and the reason. Type the 8-digit code they give you.")
                            LabeledField("8-digit code",code,{ code = it },"void-code",enabled = !busy,maxLength = 20,keyboardType = KeyboardType.Number)
                        }
                    }
                }
                error?.let { Text(it,style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.error,modifier = Modifier.testTag("void-error")) }
                PrimaryBottomButton("Void sale",{ reason?.let { onVoid(it,VoidRules.normalizedNote(note),code.takeIf { it.isNotBlank() }) } },
                    enabled = !busy && !unavailable && reason != null && validNote && (!needsApproval || VoidApprovalCodes.normalize(code) != null),tag = "confirm-void")
                SecondaryButton("Cancel",onClose,Modifier.testTag("cancel-void"),enabled = !busy)
            }
        }
    }
}
