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
import com.sunpride.van.pos.PosMoney
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
    SectionCard("Printed receipt") {
        Text(c.printMessage ?: when {
            saved == null -> "Getting the receipt…"
            saved.printed -> "Printed."
            else -> "Not printed yet."
        },style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("print-status"))
        PrintButtons(c,saved,"sale") { reprinting = it }
    }
    reprinting?.let { ReprintDialog(it,onPrint = { reason -> c.printReceipt(it.receipt.saleId,reason); reprinting = null },onClose = { reprinting = null }) }
}

@Composable private fun PrintButtons(c: VanController, saved: SavedSale?, tag: String, onReprint: (SavedSale) -> Unit) {
    if (saved == null) return
    when {
        !saved.printed -> SecondaryButton(if (c.printing) "Printing…" else "Print receipt",{ c.printReceipt(saved.receipt.saleId) },
            Modifier.testTag("$tag-print"),enabled = !c.printing)
        saved.reprintsLeft > 0 -> SecondaryButton(if (c.printing) "Printing…" else "Reprint",{ onReprint(saved) },
            Modifier.testTag("$tag-reprint"),enabled = !c.printing)
        else -> Text("Reprinted ${ReprintRules.MAX_REPRINTS} times. Ask the office for a copy.",style = MaterialTheme.typography.bodyMedium,
            modifier = Modifier.testTag("$tag-reprint-limit"))
    }
}

@Composable fun ReceiptsScreen(c: VanController) {
    var reprinting by remember { mutableStateOf<SavedSale?>(null) }
    val time = remember { DateTimeFormatter.ofPattern("h:mm a") }
    ScreenFrame("Receipts",c::back,message = c.printMessage) {
        Text("Sales saved on this trip. A copy after the first print is marked REPRINT.",style = MaterialTheme.typography.bodyMedium)
        if (c.savedSales.isEmpty()) Text("No sales on this trip yet.",style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("no-receipts"))
        c.savedSales.forEachIndexed { index, saved ->
            val r = saved.receipt
            SectionCard(Instant.ofEpochMilli(r.createdAt).atZone(ZoneId.systemDefault()).format(time)) {
                Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(r.customerName,Modifier.weight(1f),style = MaterialTheme.typography.titleMedium)
                    Text(PosMoney.format(r.totalMinor,r.currency),style = MaterialTheme.typography.titleMedium,fontWeight = FontWeight.SemiBold)
                }
                Text(r.receiptNumber,style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("receipt-$index-number"))
                val reprints = saved.prints.count { it.mayHaveReachedPaper && it.kind == com.sunpride.van.printing.PrintKind.REPRINT }
                Text(when {
                    !saved.printed -> "Not printed"
                    reprints == 0 -> "Printed · ${saved.reprintsLeft} reprints left"
                    else -> "Printed · reprinted $reprints× · ${saved.reprintsLeft} reprints left"
                },style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("receipt-$index-state"))
                PrintButtons(c,saved,"receipt-$index") { reprinting = it }
            }
        }
    }
    reprinting?.let { ReprintDialog(it,onPrint = { reason -> c.printReceipt(it.receipt.saleId,reason); reprinting = null },onClose = { reprinting = null }) }
}

/** Reason first, then print. The copy number shown is the one that will be printed. */
@Composable fun ReprintDialog(saved: SavedSale, onPrint: (String) -> Unit, onClose: () -> Unit) {
    var reason by remember { mutableStateOf<String?>(null) }
    val copy = ReprintRules.MAX_REPRINTS - saved.reprintsLeft + 1
    Dialog(onDismissRequest = onClose,properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).navigationBarsPadding().statusBarsPadding(),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Reprint receipt",style = MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${saved.receipt.customerName} · ${PosMoney.format(saved.receipt.totalMinor,saved.receipt.currency)}",style = MaterialTheme.typography.titleMedium)
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
