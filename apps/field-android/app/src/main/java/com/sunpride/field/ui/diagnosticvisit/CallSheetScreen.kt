package com.sunpride.field.ui.diagnosticvisit

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.ActionBar
import com.sunpride.field.ui.EmptyState
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.LookCard
import com.sunpride.field.ui.NoticeCard
import com.sunpride.field.ui.PageIntro
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.QuantityField
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.StatusChip
import com.sunpride.field.ui.TonalButton
import com.sunpride.field.ui.ValueRow
import org.json.JSONObject

@Composable
fun CallSheetScreen(sheet: CallSheet, controller: FieldController, modifier: Modifier = Modifier) {
    var values by rememberSaveable(sheet.outletId, sheet.revision) {
        mutableStateOf(List(sheet.lines.size * 6) { "" })
    }
    val drafts = sheet.lines.mapIndexed { i, product ->
        val v = values.subList(i * 6, i * 6 + 6)
        CallSheetDraftLine(product.productId, v[0], v[1], v[2], v[3], v[4], v[5])
    }
    fun setDrafts(next: List<CallSheetDraftLine>) { values = next.flatMap { it.values() } }
    // ANA-010: suggestions only fill local Order text; Save below is still the only way to queue anything.
    val suggestion = controller.suggestedOrder
    val order = suggestion.order?.takeIf { it.outletId == sheet.outletId }
    val valid = runCatching { CallSheetPayload.activity(sheet, drafts) }.isSuccess
    val invalid = values.any { runCatching { CallSheetPayload.quantity(it) }.isFailure }
    val saved = controller.diagnostic?.let { controller.relatedVisitRows(it) }.orEmpty().filter { (intent, _) ->
        intent.kind == "visit.activity" &&
            JSONObject(intent.serializedOperation).getJSONObject("payload").getJSONObject("activity").optString("kind") == "call_sheet"
    }
    Column(modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).testTag("call-sheet-products"), verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
            item {
                PageIntro("Call sheet", "For this visit · Week is assigned from the service date")
            }
            item {
                SectionCard("Account") {
                    Column(Modifier.padding(bottom = 6.dp)) {
                        val labels = listOf("Account name", "Address", "Buyer", "Contact #", "Acct in-charge",
                            "Receiving in-charge", "Distributor", "Sched & Cont #", "FOC", "Pricing")
                        sheet.header.fields().zip(labels).forEach { (field, label) ->
                            field.second?.let { value -> ValueRow(label, value) }
                        }
                    }
                }
            }
            if (saved.isNotEmpty()) item {
                SectionCard("Saved call sheets") {
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        saved.forEachIndexed { index, (_, state) ->
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Text("Save ${index + 1}", Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                                StatusChip(when (state) {
                                    "pending" -> "Queued"; "sending" -> "Sending"; "done" -> "Sent"; else -> "Needs review"
                                }, when (state) { "done" -> Look.Tone.GOOD; "pending", "sending" -> Look.Tone.NEUTRAL; else -> Look.Tone.WARN },
                                    textTag = "call-sheet-status")
                            }
                        }
                    }
                }
            }
            item {
                SectionCard("Suggested order", Modifier.testTag("suggested-order")) {
                    Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        suggestion.message?.let {
                            Text(it, style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.testTag("suggested-order-message"))
                        }
                        if (order != null) {
                            Text(SuggestedOrderRules.summary(order), style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.testTag("suggested-order-summary"))
                        }
                        Text(SuggestedOrderRules.NOTE, style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (order != null && SuggestedOrderRules.hasApplicable(order, sheet))
                            TonalButton("Use all suggestions", { setDrafts(SuggestedOrderRules.useAll(order, sheet, drafts)) },
                                Modifier.fillMaxWidth().testTag("suggested-order-use-all"), !controller.busy)
                        val extra = order?.let { SuggestedOrderRules.notOnSheet(it, sheet) }.orEmpty()
                        if (extra.isNotEmpty()) {
                            Text("Not on this call sheet", style = MaterialTheme.typography.labelMedium)
                            extra.forEach { line ->
                                Text("${line.code} ${line.name} — ${line.quantityText} ${line.unit}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
            }
            if (sheet.lines.isEmpty()) item {
                EmptyState("No products yet", "No products set up for this account yet. Ask your office.", GlyphKind.BOX)
            }
            itemsIndexed(sheet.lines, key = { _, product -> product.productId }) { index, product ->
                LookCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                            StatusChip(product.code, Look.Tone.ACCENT)
                            StatusChip(product.uom)
                        }
                        Text(product.name, style = MaterialTheme.typography.titleSmall)
                        product.pricing?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        order?.let { SuggestedOrderRules.suggestion(it, product.productId) }?.let { line ->
                            Text(SuggestedOrderRules.statusText(line), style = MaterialTheme.typography.labelLarge,
                                modifier = Modifier.testTag("suggestion-${product.productId}"))
                            line.reasons.forEach { reason ->
                                Text(reason, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (line.canUse) TonalButton("Use ${line.quantityText}", {
                                setDrafts(SuggestedOrderRules.use(order, drafts, product.productId))
                            }, Modifier.testTag("suggestion-use-${product.productId}"), !controller.busy)
                        }
                        repeat(3) { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                repeat(2) { column ->
                                    val measure = row * 2 + column
                                    val offset = index * 6 + measure
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                        Text(CallSheetPayload.labels[measure], style = MaterialTheme.typography.labelMedium,
                                            modifier = Modifier.padding(start = 4.dp))
                                        QuantityField(values[offset], { text ->
                                            values = values.toMutableList().also { it[offset] = text }
                                        }, Modifier.fillMaxWidth()
                                            .testTag("call-sheet-${product.productId}-${CallSheetPayload.measures[measure]}"),
                                            enabled = !controller.busy,
                                            isError = runCatching { CallSheetPayload.quantity(values[offset]) }.isFailure)
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (invalid) item { NoticeCard("Use whole numbers from 0 to 1,000,000.", tone = Look.Tone.BAD) }
            controller.diagnosticError?.let { message -> item {
                NoticeCard(message, tone = Look.Tone.BAD, textTag = "call-sheet-error")
            } }
        }
        ActionBar {
            PrimaryBottomButton("Save", {
                controller.queueCallSheet(drafts) { values = List(sheet.lines.size * 6) { "" } }
            }, Modifier.testTag("call-sheet-save"), !controller.busy && valid)
        }
    }
}
