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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.FilterChip
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
import com.sunpride.field.orders.OrderDraftFailure
import com.sunpride.field.orders.OrderSubmission
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

/** Offline editor: account products, selling-unit choices and cached price previews. */
@Composable
fun OrderDraftScreen(visit: VisitDisplay, sheet: CallSheet, controller: FieldController, modifier: Modifier = Modifier) {
    val draft = controller.openOrderDraft
    val terms = controller.diagnosticOrderTerms
    val catalog = OrderCatalog.of(sheet, terms)
    var query by rememberSaveable(sheet.outletId) { mutableStateOf("") }
    var values by rememberSaveable(sheet.outletId, sheet.revision, controller.orderDraftId) {
        mutableStateOf(catalog.map { item -> draft?.lines?.firstOrNull { it.productId == item.productId }?.quantity?.toString() ?: "" })
    }
    var chosenUnits by rememberSaveable(sheet.outletId, sheet.revision, terms, controller.orderDraftId) {
        mutableStateOf(catalog.map { item ->
            draft?.lines?.firstOrNull { it.productId == item.productId }?.uom?.takeIf { item.unit(it) != null } ?: item.uom
        })
    }
    val units = catalog.zip(chosenUnits).associate { (item, unit) -> item.productId to unit }
    val parsed = values.map { runCatching { OrderDraftRules.quantity(it) } }
    val invalid = parsed.any { it.isFailure }
    val quantities = catalog.zip(parsed).mapNotNull { (item, q) -> q.getOrNull()?.let { item.productId to it } }
    val stale = draft?.let { OrderDraftRules.staleLines(it, sheet, terms) }.orEmpty()
    val changedPrices = draft != null && (stale.isNotEmpty() || draft.priceList != terms?.priceList)
    val results = OrderCatalog.search(catalog, query)
    Column(modifier.fillMaxSize().imePadding().padding(horizontal = 20.dp, vertical = 16.dp)) {
        LazyColumn(Modifier.weight(1f).testTag("order-products"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(if (draft == null) "New order" else "Order draft", style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.testTag("order-title"))
                Text(orderAssociation(visit, draft), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-association"))
                Text("Enter whole quantities in each product's unit. Prices are a preview; the office confirms them when the order arrives.", style = MaterialTheme.typography.bodySmall,
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
            if (changedPrices) item {
                Text(OrderDraftFailure.Code.PRICES_CHANGED.text,
                    color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("order-stale"))
            }
            if (results.isEmpty()) item {
                Text(if (catalog.isEmpty()) "No products set up for this account yet. Ask your office."
                    else "No products match", Modifier.testTag("order-empty"))
            }
            items(results, key = { it.productId }) { item ->
                val index = catalog.indexOf(item)
                SectionCard(item.code) {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(item.name, style = MaterialTheme.typography.titleSmall)
                                Text(OrderSubmission.unitPrice(item.unit(chosenUnits[index])?.unitPriceMinor, chosenUnits[index]),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    modifier = Modifier.testTag("order-price-${item.productId}"))
                                item.priceNote?.let { Text("Pricing note · $it", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
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
                        if (item.units.size > 1) {
                            Text("Selling unit", style = MaterialTheme.typography.bodySmall)
                            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item.units.forEach { unit ->
                                    FilterChip(selected = chosenUnits[index] == unit.uom,
                                        onClick = { chosenUnits = chosenUnits.toMutableList().also { it[index] = unit.uom } },
                                        label = { Text(unit.uom) }, enabled = !controller.busy,
                                        shape = RoundedCornerShape(10.dp),
                                        modifier = Modifier.heightIn(min = 48.dp).testTag("order-unit-${item.productId}-${unit.uom}"))
                                }
                            }
                        } else Text(chosenUnits[index], style = MaterialTheme.typography.bodySmall)
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
            // SP-0060: once the screen matches the saved draft, the next step is review.
            val unsaved = draft == null || quantities.toSet() != draft.lines.map { it.productId to it.quantity }.toSet() ||
                draft.lines.any { units[it.productId] != it.uom }
            if (!unsaved && !changedPrices) PrimaryBottomButton("Review order", { controller.openOrderReview() },
                Modifier.weight(1f).testTag("order-review"), !controller.busy)
            else PrimaryBottomButton("Save draft", { controller.saveOrderDraft(quantities, units) },
                Modifier.weight(1f).testTag("order-save"), !controller.busy && !invalid && quantities.isNotEmpty())
        }
    }
}
