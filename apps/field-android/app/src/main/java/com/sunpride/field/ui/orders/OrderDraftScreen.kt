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
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.KeyboardOptions
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
import com.sunpride.field.orders.OrderCatalog
import com.sunpride.field.orders.OrderDraft
import com.sunpride.field.orders.OrderDraftRules
import com.sunpride.field.orders.OrderDraftFailure
import com.sunpride.field.orders.OrderSubmission
import com.sunpride.field.storage.CallSheet
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.ActionBar
import com.sunpride.field.ui.EmptyState
import com.sunpride.field.ui.FieldTextField
import com.sunpride.field.ui.FilterPill
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.LookCard
import com.sunpride.field.ui.NoticeCard
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.QuantityField
import com.sunpride.field.ui.SearchField
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.StatusChip
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
    var deliveryDate by rememberSaveable(sheet.outletId, controller.orderDraftId) { mutableStateOf(draft?.requestedDeliveryDate ?: "") }
    val presell = controller.diagnosticFlow?.getJSONObject("definition")?.optString("channelProfile") == "pre_sell"
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
    Column(modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).testTag("order-products"), verticalArrangement = Arrangement.spacedBy(12.dp),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp)) {
            item {
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(if (draft == null) "Add order" else "Edit order", style = MaterialTheme.typography.headlineSmall,
                        modifier = Modifier.testTag("order-title"))
                    Text(orderAssociation(visit, draft), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-association"))
                }
            }
            item {
                NoticeCard("Enter whole quantities in each product's unit. Prices are a preview; the office confirms them when the order arrives.",
                    textTag = "order-price-note")
            }
            item {
                SearchField(query, { query = it }, "Search code, name or barcode", Modifier.testTag("order-search"))
                Text("${quantities.size} of ${catalog.size} products in this order",
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(start = 6.dp, top = 8.dp).testTag("order-count"))
            }
            if (presell || deliveryDate.isNotBlank()) item {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    FieldTextField(deliveryDate, { deliveryDate = it }, label = { Text("Requested delivery day · YYYY-MM-DD") },
                        modifier = Modifier.fillMaxWidth().testTag("order-delivery-date"), singleLine = true)
                    Text("Requested only. The office confirms the delivery day within the delivery policy.",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 6.dp))
                }
            }
            if (changedPrices) item {
                NoticeCard(OrderDraftFailure.Code.PRICES_CHANGED.text, tone = Look.Tone.BAD, textTag = "order-stale")
            }
            if (results.isEmpty()) item {
                if (catalog.isEmpty()) EmptyState("No products yet", "No products set up for this account yet. Ask your office.", GlyphKind.BOX,
                    Modifier.testTag("order-empty"))
                else EmptyState("No match", "No products match", GlyphKind.SEARCH, Modifier.testTag("order-empty"))
            }
            items(results, key = { it.productId }) { item ->
                val index = catalog.indexOf(item)
                LookCard {
                    Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        StatusChip(item.code, Look.Tone.ACCENT)
                        Text(item.name, style = MaterialTheme.typography.titleSmall)
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Text(OrderSubmission.unitPrice(item.unit(chosenUnits[index])?.unitPriceMinor, chosenUnits[index]),
                                    style = MaterialTheme.typography.bodyMedium,
                                    modifier = Modifier.testTag("order-price-${item.productId}"))
                                item.priceNote?.let { Text("Pricing note · $it", style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            }
                            QuantityField(values[index], { text -> values = values.toMutableList().also { it[index] = text } },
                                Modifier.width(104.dp).testTag("order-qty-${item.productId}"),
                                enabled = !controller.busy, isError = parsed[index].isFailure, placeholder = "Qty")
                        }
                        // FLD-110: the reason sits under the red box itself (a list-end notice was off screen and never composed).
                        if (parsed[index].isFailure) Text(OrderDraftFailure.Code.INVALID_QUANTITY.text,
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.testTag("order-qty-error-${item.productId}"))
                        if (item.units.size > 1) {
                            Text("Selling unit", style = MaterialTheme.typography.labelMedium)
                            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                                horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                item.units.forEach { unit ->
                                    FilterPill(unit.uom, chosenUnits[index] == unit.uom,
                                        { if (!controller.busy) chosenUnits = chosenUnits.toMutableList().also { it[index] = unit.uom } },
                                        Modifier.testTag("order-unit-${item.productId}-${unit.uom}"))
                                }
                            }
                        } else Text(chosenUnits[index], style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            controller.diagnosticError?.let { message -> item {
                NoticeCard(message, tone = Look.Tone.BAD, textTag = "order-error")
            } }
            if (draft != null) item {
                StatusChip("Draft saved", Look.Tone.GOOD, textTag = "order-saved")
            }
        }
        ActionBar {
            // FLD-110: Save is disabled while a Qty is invalid; always say why next to it.
            if (invalid) Text(OrderDraftFailure.Code.INVALID_QUANTITY.text, style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(bottom = 6.dp).testTag("order-invalid"))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (draft != null) SecondaryButton("Discard", { controller.discardOrderDraft() },
                    Modifier.weight(1f).testTag("order-discard"), !controller.busy, danger = true)
                // SP-0060: once the screen matches the saved draft, the next step is review.
                val unsaved = draft == null || quantities.toSet() != draft.lines.map { it.productId to it.quantity }.toSet() ||
                    draft.lines.any { units[it.productId] != it.uom } || draft.requestedDeliveryDate != deliveryDate.takeIf { it.isNotBlank() }
                if (!unsaved && !changedPrices) PrimaryBottomButton("Review order", { controller.openOrderReview() },
                    Modifier.weight(1f).testTag("order-review"), !controller.busy)
                else PrimaryBottomButton("Save draft", { controller.saveOrderDraft(quantities, units, deliveryDate.takeIf { it.isNotBlank() }) },
                    Modifier.weight(1f).testTag("order-save"), !controller.busy && !invalid && quantities.isNotEmpty())
            }
        }
    }
}
