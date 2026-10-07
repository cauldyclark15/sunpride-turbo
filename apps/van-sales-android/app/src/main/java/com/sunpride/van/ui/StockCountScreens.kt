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

/** VAN-023 physical stock count: sellable and damaged are counted separately for every cached product. */
@Composable fun StockCountScreen(c: VanController) {
    val summary = c.stockSummary
    val saved = summary?.saved
    val draft = c.stockDraft
    val expectedLines = summary?.lines ?: emptyList()
    val parsed = expectedLines.map { line ->
        line to (draft.counts[line.productId to line.status]?.let { VanRules.parseQuantity(it,line.quantityScale) })
    }
    val validCounts = summary != null && parsed.all { it.second != null }
    val lines = parsed.map { (line,counted) -> StockCountLine(line.productId,line.status,line.expectedBase,counted ?: -1L,draft.reasons[line.productId to line.status]) }
    val totals = if (validCounts) runCatching { StockReconciliationRules.summary(lines) }.getOrNull() else null
    val reasons = StockVarianceReasons.offered(c.policy)
    val anyOther = lines.any { it.expectedBase != it.countedBase && it.reasonCode == "other" }
    val noteValid = draft.note.length <= 300 && draft.note.none(Char::isISOControl) && (!anyOther || draft.note.isNotBlank())
    val needsApproval = totals?.let { StockReconciliationRules.needsApproval(c.policy,it.anyVariance) } == true
    val unavailable = needsApproval && c.policy?.stockReconciliation?.key == null
    val code = if (validCounts && summary != null) StockReconciliationRules.countCode(summary.tripId,draft.reconciliationId,lines) else null
    val ready = summary != null && summary.countable && saved == null && validCounts && totals != null && noteValid && !unavailable &&
        lines.all { it.expectedBase == it.countedBase || it.reasonCode in reasons.map { r -> r.code } } &&
        (!needsApproval || VoidApprovalCodes.normalize(draft.code) != null)

    fun edit(next: StockDraft, clearsCode: Boolean = false) = c.editStock(if (clearsCode) next.copy(code = "") else next)
    fun setCount(line: StockLineSummary, text: String) {
        edit(draft.copy(counts = draft.counts + ((line.productId to line.status) to text)),clearsCode = true)
    }
    fun sameAsExpected(productId: String) {
        val counts = expectedLines.filter { it.productId == productId }.associate { (it.productId to it.status) to VanRules.quantity(it.expectedBase,it.quantityScale) }
        edit(draft.copy(counts = draft.counts + counts,reasons = draft.reasons - (productId to StockCountLine.AVAILABLE) - (productId to StockCountLine.DAMAGED)),true)
    }

    ScreenFrame("Count stock",c::back,
        action = if (saved != null) "Done" else if (c.busy) "Saving…" else "Save stock count",actionTag = "save-stock",
        enabled = if (saved != null) true else ready && !c.busy,
        onAction = { if (saved != null) c.back() else c.saveStockCount() },
        footer = if (saved == null && totals != null) "${totals.varianceLines} lines differ · ${totals.shortBase} short · ${totals.overBase} over" else null,
        message = c.message) {
        when {
            summary == null -> Text("Getting this trip's truck stock…")
            saved != null -> SavedStockCount(saved,summary.tripNumber,summary.lines)
            !summary.countable -> Text("Start the trip before counting stock.",Modifier.testTag("stock-count-blocked"))
            else -> {
                Text("Count sellable and damaged stock separately. Counts are entered in each product's UOM.",style = MaterialTheme.typography.bodyMedium)
                expectedLines.groupBy { it.productId }.forEach { (productId, productLines) ->
                    val meta = summary.lines.first { it.productId == productId }
                    SectionCard(meta.productName) {
                        Text("${meta.productCode} · ${meta.uomCode}",style = MaterialTheme.typography.bodyMedium)
                        productLines.forEach { line ->
                            val text = draft.counts[line.productId to line.status] ?: ""
                            val count = draft.counts[line.productId to line.status]?.let { VanRules.parseQuantity(it,line.quantityScale) }
                            val difference = count?.let { Math.subtractExact(it,line.expectedBase) }
                            val label = if (line.status == StockCountLine.AVAILABLE) "Sellable" else "Damaged"
                            LabeledField("$label counted",text,{ setCount(line,it) },
                                "stock-count-${line.productId}-${line.status}",numeric = true,maxLength = 24,keyboardType = KeyboardType.Decimal,enabled = !c.busy)
                            Text("Expected ${VanRules.quantity(line.expectedBase,line.quantityScale)} ${line.uomCode}",style = MaterialTheme.typography.bodyMedium)
                            if (difference != null) Text(stockDifference(difference,line.uomCode,line.quantityScale),
                                Modifier.testTag("stock-difference-${line.productId}-${line.status}"),style = MaterialTheme.typography.titleMedium)
                            if (difference != null && difference != 0L) {
                                Text("Why is this line different?",style = MaterialTheme.typography.bodyMedium)
                                reasons.forEach { reason ->
                                    StockReasonRow(reason,draft.reasons[line.productId to line.status] == reason.code,
                                        "stock-reason-${line.productId}-${line.status}-${reason.code}") {
                                        edit(draft.copy(reasons = draft.reasons + ((line.productId to line.status) to reason.code)),true)
                                    }
                                }
                            }
                        }
                        SecondaryButton("Same as expected",{ sameAsExpected(productId) },Modifier.testTag("stock-same-$productId"),!c.busy)
                    }
                }
                if (totals != null && totals.anyVariance) {
                    SectionCard("Difference") {
                        Text("${totals.varianceLines} lines differ · ${totals.shortBase} short · ${totals.overBase} over",style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("stock-variance"))
                        if (anyOther) LabeledField("Note (required)",draft.note,{ edit(draft.copy(note = it)) },"stock-note",enabled = !c.busy,maxLength = 300)
                        else LabeledField("Note (optional)",draft.note,{ edit(draft.copy(note = it)) },"stock-note",enabled = !c.busy,maxLength = 300)
                        if (needsApproval) {
                            Text("Supervisor approval needed",style = MaterialTheme.typography.titleMedium)
                            if (unavailable) Text("Supervisor approval is not set up on this phone. Sync, then try again.",Modifier.testTag("stock-approval-unavailable"))
                            else {
                                Text("Read them: Trip ${summary.tripNumber}, count code ${code?.let(StockReconciliationRules::displayCountCode) ?: "—"}, ${totals.varianceLines} lines differ, ${totals.shortBase} short, ${totals.overBase} over. Type the 8-digit code they give you.",
                                    style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("stock-approval-script"))
                                LabeledField("8-digit approval code",draft.code,{ edit(draft.copy(code = it)) },"stock-count-code",enabled = !c.busy,maxLength = 20,keyboardType = KeyboardType.Number)
                            }
                        }
                    }
                } else if (validCounts) {
                    SectionCard("Difference") { Text("No differences",style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("stock-variance")) }
                }
                Text("After saving, this trip takes no more sales, returns, damage or stock changes.",style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable private fun StockReasonRow(reason: StockVarianceReason, selected: Boolean, tag: String, onSelect: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected,onClick = onSelect,role = Role.RadioButton).testTag(tag),verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected,onClick = null,colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
        Text(reason.label,Modifier.weight(1f).padding(start = 8.dp),style = MaterialTheme.typography.bodyLarge)
    }
}

@Composable private fun SavedStockCount(saved: StockCountResult, tripNumber: String, summaries: List<StockLineSummary>) {
    SectionCard("Stock count saved") {
        Text("Truck stock now matches your count",style = MaterialTheme.typography.headlineSmall,modifier = Modifier.testTag("stock-saved"))
        Text("Trip $tripNumber")
        Text("${saved.varianceLines} lines differed · ${saved.shortBase} short · ${saved.overBase} over",modifier = Modifier.testTag("stock-saved-summary"))
        if (saved.approved) Text("Approved by supervisor code",modifier = Modifier.testTag("stock-saved-approved"))
        else Text("No supervisor approval needed",modifier = Modifier.testTag("stock-saved-no-approval"))
        saved.note?.let { Text("Note: $it") }
    }
    SectionCard("Lines that differed") {
        val products = summaries.associateBy { it.productId }
        val different = saved.lines.filter { it.expectedBase != it.countedBase }
        if (different.isEmpty()) Text("No differences")
        different.forEach { line ->
            val p = products[line.productId]
            val uom = p?.uomCode ?: "units"
            Text("${p?.productName ?: line.productId} · ${if (line.status == StockCountLine.AVAILABLE) "Sellable" else "Damaged"}",style = MaterialTheme.typography.titleMedium)
            Text("${p?.let { VanRules.quantity(line.expectedBase,it.quantityScale) } ?: line.expectedBase} → ${p?.let { VanRules.quantity(line.countedBase,it.quantityScale) } ?: line.countedBase} $uom · ${StockVarianceReasons.label(line.reasonCode ?: "")}",style = MaterialTheme.typography.bodyMedium)
        }
    }
    Text("The approved truck stock is frozen on this phone.",style = MaterialTheme.typography.bodyMedium)
}

private fun stockDifference(delta: Long, uom: String, scale: Long): String = when {
    delta == 0L -> "Matches expected"
    delta < 0L -> "${VanRules.quantity(Math.negateExact(delta),scale)} $uom short"
    else -> "${VanRules.quantity(delta,scale)} $uom over"
}