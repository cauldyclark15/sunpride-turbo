package com.sunpride.field.ui.orders

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sunpride.field.orders.OrderCatalog
import com.sunpride.field.orders.OrderDraft
import com.sunpride.field.orders.OrderDraftRules
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.SunprideTokens
import com.sunpride.field.ui.VisitDisplay

/** What the editor shows about the order's customer/territory/route before and after the first save. */
fun orderAssociation(visit: VisitDisplay, draft: OrderDraft?): String = listOfNotNull(
    (draft?.customerCode ?: visit.customerCode ?: visit.outletCode)?.let { "Customer $it" },
    draft?.territoryCode?.let { "Territory $it" },
).joinToString(" · ").ifEmpty { visit.outlet }

/** Offline order draft editor: search the account's products, enter quantities in the setup UOM. */
@Composable
fun OrderDraftScreen(visit: VisitDisplay, sheet: CallSheet, controller: FieldController, modifier: Modifier = Modifier) {
    val draft = controller.openOrderDraft
    val catalog = OrderCatalog.of(sheet)
    var query by rememberSaveable(sheet.outletId) { mutableStateOf("") }
    var values by rememberSaveable(sheet.outletId, sheet.revision, controller.orderDraftId) {
        mutableStateOf(catalog.map { item -> draft?.lines?.firstOrNull { it.productId == item.productId }?.quantity?.toString() ?: "" })
    }
    val parsed = values.map { runCatching { OrderDraftRules.quantity(it) } }
    val invalid = parsed.any { it.isFailure }
    val quantities = catalog.zip(parsed).mapNotNull { (item, q) -> q.getOrNull()?.let { item.productId to it } }
    val stale = draft?.let { OrderDraftRules.staleLines(it, sheet) }.orEmpty()
    val results = OrderCatalog.search(catalog, query)
    Column(modifier.fillMaxSize().imePadding().padding(horizontal = 20.dp, vertical = 16.dp)) {
        LazyColumn(Modifier.weight(1f).testTag("order-products"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(if (draft == null) "New order" else "Order draft", style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.testTag("order-title"))
                Text(orderAssociation(visit, draft), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-association"))
                Text("Saved on this phone. Review and send come next. Prices are set by the office; " +
                    "this draft records quantities only.", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-price-note"))
            }
            item {
                OutlinedTextField(query, { query = it }, singleLine = true,
                    modifier = Modifier.fillMaxWidth().height(56.dp).testTag("order-search"),
                    placeholder = { Text("Search code, name or barcode") },
                    shape = SunprideTokens.shapes.small, textStyle = MaterialTheme.typography.bodyMedium,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                        unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)))
                Text("${quantities.size} of ${catalog.size} products in this order",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 8.dp).testTag("order-count"))
            }
            if (stale.isNotEmpty()) item {
                Text("${stale.size} saved line(s) are no longer set up for this account and will be removed when you save.",
                    color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("order-stale"))
            }
            if (results.isEmpty()) item {
                Text(if (catalog.isEmpty()) "No products set up for this account yet. Ask your office."
                    else "No products match", Modifier.testTag("order-empty"))
            }
            items(results, key = { it.productId }) { item ->
                val index = catalog.indexOf(item)
                SectionCard(item.code) {
                    Row(Modifier.fillMaxWidth().padding(16.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(item.name, style = MaterialTheme.typography.titleSmall)
                            Text(listOfNotNull(item.uom, item.priceNote).joinToString(" · "),
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        OutlinedTextField(values[index], { text -> values = values.toMutableList().also { it[index] = text } },
                            singleLine = true, enabled = !controller.busy,
                            modifier = Modifier.width(96.dp).height(56.dp).testTag("order-qty-${item.productId}"),
                            placeholder = { Text("Qty") },
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                            isError = parsed[index].isFailure,
                            shape = SunprideTokens.shapes.small, textStyle = MaterialTheme.typography.bodyMedium,
                            colors = OutlinedTextFieldDefaults.colors(
                                focusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.5f),
                                unfocusedBorderColor = MaterialTheme.colorScheme.outline.copy(alpha = 0.28f)))
                    }
                }
            }
            if (invalid) item { Text("Use whole numbers from 1 to 99,999.", color = MaterialTheme.colorScheme.error) }
            controller.diagnosticError?.let { message -> item {
                Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("order-error"))
            } }
            if (draft != null) item {
                Text("Draft saved", style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-saved"))
            }
            item { Spacer(Modifier.height(16.dp)) }
        }
        Spacer(Modifier.height(12.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (draft != null) SecondaryButton("Discard", { controller.discardOrderDraft() },
                Modifier.weight(1f).testTag("order-discard"), !controller.busy, danger = true)
            PrimaryBottomButton("Save draft", { controller.saveOrderDraft(quantities) },
                Modifier.weight(1f).testTag("order-save"), !controller.busy && !invalid && quantities.isNotEmpty())
        }
    }
}
