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
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.SunprideTokens
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
    val valid = runCatching { CallSheetPayload.activity(sheet, drafts) }.isSuccess
    val invalid = values.any { runCatching { CallSheetPayload.quantity(it) }.isFailure }
    val saved = controller.diagnostic?.let { controller.relatedVisitRows(it) }.orEmpty().filter { (intent, _) ->
        intent.kind == "visit.activity" &&
            JSONObject(intent.serializedOperation).getJSONObject("payload").getJSONObject("activity").optString("kind") == "call_sheet"
    }
    Column(modifier.fillMaxSize().imePadding().padding(horizontal = 20.dp, vertical = 16.dp)) {
        LazyColumn(Modifier.weight(1f).testTag("call-sheet-products"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text("Call sheet", style = MaterialTheme.typography.headlineMedium)
                Text("For this visit · Week is assigned from the service date",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item {
                SectionCard("Account") {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        val labels = listOf("Account name", "Address", "Buyer", "Contact #", "Acct in-charge",
                            "Receiving in-charge", "Distributor", "Sched & Cont #", "FOC", "Pricing")
                        sheet.header.fields().zip(labels).forEach { (field, label) ->
                            field.second?.let { value ->
                                Column {
                                    Text(label, style = MaterialTheme.typography.labelMedium,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    Text(value, style = MaterialTheme.typography.bodyMedium)
                                }
                            }
                        }
                    }
                }
            }
            if (saved.isNotEmpty()) item {
                SectionCard("Saved call sheets") {
                    saved.forEachIndexed { index, (_, state) ->
                        Text("Save ${index + 1} · ${when (state) {
                            "pending" -> "Queued"; "sending" -> "Sending"; "done" -> "Sent"; else -> "Needs review"
                        }}", Modifier.padding(horizontal = 16.dp, vertical = 8.dp).testTag("call-sheet-status"),
                            style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            if (sheet.lines.isEmpty()) item { Text("No products set up for this account yet. Ask your office.") }
            itemsIndexed(sheet.lines, key = { _, product -> product.productId }) { index, product ->
                SectionCard(product.code) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(product.name, style = MaterialTheme.typography.titleSmall)
                        Text(listOfNotNull(product.uom, product.pricing).joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        repeat(3) { row ->
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                repeat(2) { column ->
                                    val measure = row * 2 + column
                                    val offset = index * 6 + measure
                                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Text(CallSheetPayload.labels[measure], style = MaterialTheme.typography.labelMedium)
                                        OutlinedTextField(values[offset], { text ->
                                            values = values.toMutableList().also { it[offset] = text }
                                        }, singleLine = true, enabled = !controller.busy,
                                            modifier = Modifier.fillMaxWidth().height(56.dp)
                                                .testTag("call-sheet-${product.productId}-${CallSheetPayload.measures[measure]}"),
                                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                                            isError = runCatching { CallSheetPayload.quantity(values[offset]) }.isFailure,
                                            shape = SunprideTokens.shapes.small, textStyle = MaterialTheme.typography.bodyMedium,
                                            colors = OutlinedTextFieldDefaults.colors(
                                                focusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                                                unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)))
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if (invalid) item { Text("Use whole numbers from 0 to 1,000,000.", color = MaterialTheme.colorScheme.error) }
            controller.diagnosticError?.let { message -> item {
                Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("call-sheet-error"))
            } }
            item { Spacer(Modifier.height(16.dp)) }
        }
        Spacer(Modifier.height(12.dp))
        PrimaryBottomButton("Save call sheet", {
            controller.queueCallSheet(drafts) { values = List(sheet.lines.size * 6) { "" } }
        }, Modifier.testTag("call-sheet-save"), !controller.busy && valid)
    }
}
