package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalFocusManager
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
        c.batchCountPositions.all { b->val p=c.products.singleOrNull {it.productId==b.productId};p!=null && VanRules.parseQuantity(draft.batchCounts["${b.lotId}:${b.status}"]?:"",p.quantityScale)!=null } &&
        lines.all { it.expectedBase == it.countedBase || it.reasonCode in reasons.map { r -> r.code } } &&
        (!needsApproval || VoidApprovalCodes.normalize(draft.code) != null)

    // VAN-078: Save stays off until every line is counted; say which line is still missing instead of a silent grey button.
    val missing = if (summary != null && saved == null) stockCountMissing(expectedLines,draft.counts,draft.reasons,reasons.map { it.code }.toSet()) +
        c.batchCountPositions.filter { b -> val p = c.products.singleOrNull { it.productId == b.productId }
            p == null || VanRules.parseQuantity(draft.batchCounts["${b.lotId}:${b.status}"] ?: "",p.quantityScale) == null }
            .map { b -> "${c.products.singleOrNull { it.productId == b.productId }?.name ?: "Item"} · batch ${b.batch} count" } else emptyList()
    val focus = LocalFocusManager.current
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
        // VAN-079 (P3, as VAN-082): a refusal of the tap (e.g. a wrong approval code) shows next to the button, not at
        // the top of the long list where it is off screen.
        footer = stockCountFooter(saved == null,c.message,summary?.waiting,missing,totals),
        message = null) {
        when {
            summary == null -> Text("Getting this trip's truck stock…")
            saved != null -> {
                if (summary.officeWaiting) Text(CountOfficeRules.WAITING_DAMAGE_TEXT,Modifier.testTag("stock-office-waiting"),style = MaterialTheme.typography.bodyLarge)
                SavedStockCount(saved,summary.tripNumber,summary.lines)
            }
            summary.waiting != null -> Text(summary.waiting,Modifier.testTag("stock-count-damage-waiting"),style = MaterialTheme.typography.bodyLarge)
            !summary.countable -> Text("Start the trip before counting stock.",Modifier.testTag("stock-count-blocked"))
            else -> {
                summary.refusal?.let { Text(it,Modifier.testTag("stock-office-refused"),color = MaterialTheme.colorScheme.error,style = MaterialTheme.typography.bodyLarge) }
                Text("Count sellable and damaged stock separately. Counts are entered in each product's UOM.",style = MaterialTheme.typography.bodyMedium)
                if (c.sync.review > 0) Text("Some earlier work needs review. Expected stock excludes refused work; enter what is physically on the truck. The earlier records are kept for your supervisor.",style = MaterialTheme.typography.bodyMedium)
                c.batchCountPositions.forEach {b->val p=c.products.single {it.productId==b.productId};val key="${b.lotId}:${b.status}"
                    SectionCard("${p.name} · batch ${b.batch}") {
                        Text("${b.status} · ${b.qualityStatus} · expected ${p.displayQuantity(b.quantityBase)} ${p.uomCode}")
                        LabeledField("Batch counted ${p.uomCode}",draft.batchCounts[key]?:"",{edit(draft.copy(batchCounts=draft.batchCounts+(key to it)))},"batch-count-$key",numeric=true,enabled=!c.busy)
                    }
                }
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
                        // VAN-078: the button takes the focus out of the count field, so the keyboard closes and the list scrolls again.
                        SecondaryButton("Same as expected",{ focus.clearFocus(force = true); sameAsExpected(productId) },Modifier.testTag("stock-same-$productId"),!c.busy)
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
/** VAN-078: what still stops Save, in list order: a line with no count, then a differing line with no reason. */
internal fun stockCountMissing(lines: List<StockLineSummary>, counts: Map<Pair<String,String>,String>, reasons: Map<Pair<String,String>,String?>, offered: Set<String>): List<String> =
    lines.mapNotNull { line ->
        val key = line.productId to line.status
        val label = if (line.status == StockCountLine.AVAILABLE) "sellable" else "damaged"
        val counted = counts[key]?.let { VanRules.parseQuantity(it,line.quantityScale) }
        when {
            counted == null -> "${line.productName} · $label count"
            counted != line.expectedBase && reasons[key] !in offered -> "${line.productName} · $label reason"
            else -> null
        }
    }
/** "Still to do: Sample Fruit Cocktail · damaged count and 2 more". */
internal fun stockMissingFooter(missing: List<String>): String =
    "Still to do: ${missing.first()}" + if (missing.size > 1) " and ${missing.size - 1} more" else ""
/**
 * VAN-079: the line next to Save stock count. The answer to the last tap (wrong code, stock changed…) first, then
 * why counting must wait, then what is still missing, then the totals.
 */
internal fun stockCountFooter(open: Boolean, message: String?, waiting: String?, missing: List<String>, totals: StockVarianceSummary?): String? = when {
    !message.isNullOrBlank() -> message
    !open -> null
    waiting != null -> waiting
    missing.isNotEmpty() -> stockMissingFooter(missing)
    totals != null -> "${totals.varianceLines} lines differ · ${totals.shortBase} short · ${totals.overBase} over"
    else -> null
}
