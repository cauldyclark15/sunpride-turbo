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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.data.Product
import com.sunpride.van.pos.*
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * VAN-019 customer returns. One customer per return: link the receipt it was bought on (or none), add each
 * returned product with its unit, quantity, batch, reason and what happens to the goods, then save. The screen
 * shows every problem and whether the office must approve; the store re-checks everything while saving.
 */
@Composable fun ReturnScreen(c: VanController) {
    val draft = c.returnDraft
    var note by remember(draft?.returnId) { mutableStateOf("") }
    var adding by remember { mutableStateOf(false) }
    val result = remember(draft,c.customers,c.products,c.returnFacts,c.trip,c.session,note) { c.returnResult(note) }
    val quote = result?.quote
    ScreenFrame("Customer return",c::back,action = if (c.busy) "Saving…" else "Save return",actionTag = "save-return",
        enabled = !c.busy && result?.ok == true,onAction = { c.saveReturn(note) },message = c.message,
        footer = when {
            draft == null || draft.lines.isEmpty() -> "No returned products yet"
            quote?.approvalRequired == true -> "Needs office approval"
            quote != null -> "No approval needed"
            else -> "Fix the problems above to save"
        }) {
        if (draft == null) { Text("No return in progress."); return@ScreenFrame }
        SectionCard(VanRules.sourceLabel(draft.customer.source)) {
            Text(draft.customer.name,style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("return-customer"))
            if (draft.customer.code.isNotBlank()) Text(draft.customer.code,style = MaterialTheme.typography.bodyMedium)
        }
        val sales = c.returnFacts?.sales?.filter { it.customerId == draft.customer.outletId } ?: emptyList()
        SectionCard("Bought on") {
            ReturnChoice("Not from a receipt on this phone",draft.originalSaleId == null,"return-sale-none") { c.linkReturnSale(null) }
            sales.forEach { sale ->
                ReturnChoice("Receipt ${sale.receiptNumber.takeLast(13)} · ${time(sale.createdAt)}",draft.originalSaleId == sale.saleId,"return-sale-${sale.receiptNumber}") { c.linkReturnSale(sale.saleId) }
            }
            if (sales.isEmpty()) Text("No sale to this customer is saved on this phone.",style = MaterialTheme.typography.bodyMedium)
        }
        val issues = result?.issues ?: emptyList()
        if (draft.lines.isNotEmpty() && issues.isNotEmpty()) SectionCard("Before you can save") {
            issues.forEachIndexed { index,issue ->
                Text(VanRules.returnMessage(issue.problem,issue.productId?.let { id -> c.products.firstOrNull { it.productId == id }?.name }),
                    style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("return-issue-$index"))
            }
        }
        if (draft.lines.isEmpty()) Text("Add each product the customer is returning.",style = MaterialTheme.typography.bodyLarge)
        draft.lines.forEachIndexed { index,line ->
            val product = c.products.firstOrNull { it.productId == line.productId }
            val quoted = quote?.lines?.getOrNull(index)
            SectionCard("Line ${index+1}") {
                Column(Modifier.semantics(mergeDescendants = true) {}.testTag("return-line-$index"),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(product?.name ?: "Product no longer on this phone",style = MaterialTheme.typography.titleMedium)
                    product?.let { p -> Text(quantityLabel(p,line.uomCode,line.quantityBase),style = MaterialTheme.typography.bodyLarge) }
                    Text(listOfNotNull(ReturnPolicy.DEFAULT.reason(line.reasonCode)?.label,line.disposition?.label).joinToString(" · "),style = MaterialTheme.typography.bodyMedium)
                    val pack = listOfNotNull(line.lotNumber?.takeIf { it.isNotBlank() }?.let { "Batch ${ReturnRules.normalizeLot(it) ?: it}" },
                        line.expiryDate?.takeIf { it.isNotBlank() }?.let { "Expiry\u00A0$it" }).joinToString(" · ")
                    if (pack.isNotEmpty()) Text(pack,style = MaterialTheme.typography.bodyMedium)
                    quoted?.let { Text(VanRules.stockEffectLabel(it.stockEffect,it.approvalRequired),style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("return-effect-$index")) }
                }
                SecondaryButton("Remove",{ c.removeReturnLine(index) },Modifier.testTag("return-remove-$index"),!c.busy)
            }
        }
        SecondaryButton("Add returned product",{ adding = true },Modifier.testTag("return-add-product"),!c.busy && draft.lines.size < ReturnRules.MAX_LINES)
        quote?.takeIf { it.approvalRequired }?.let { q ->
            SectionCard("Office approval needed") {
                Column(Modifier.semantics(mergeDescendants = true) {}.testTag("return-approval"),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    q.approvalReasons.forEach { Text(VanRules.approvalLabel(it),style = MaterialTheme.typography.bodyLarge) }
                    Text("You can save it now. Goods waiting for approval are never sold.",style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        LabeledField("Note (optional)",note,{ note = it },"return-note")
        SecondaryButton("Cancel return",c::cancelReturn,Modifier.testTag("return-cancel"),!c.busy)
    }
    if (adding && draft != null) ReturnLineDialog(c,onAdd = { c.addReturnLine(it); adding = false },onClose = { adding = false })
}

/** Pick a product, then capture unit, quantity, reason, what happens to the goods, batch and expiry. */
@Composable private fun ReturnLineDialog(c: VanController, onAdd: (ReturnLineInput) -> Unit, onClose: () -> Unit) {
    var product by remember { mutableStateOf<Product?>(null) }
    var query by remember { mutableStateOf("") }
    var uom by remember { mutableStateOf<String?>(null) }
    var quantity by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf<String?>(null) }
    var disposition by remember { mutableStateOf<ReturnDisposition?>(null) }
    var lot by remember { mutableStateOf("") }
    var expiry by remember { mutableStateOf("") }
    val policy = ReturnPolicy.DEFAULT
    Dialog(onDismissRequest = onClose,properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).imePadding().navigationBarsPadding().statusBarsPadding(),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Returned product",style = MaterialTheme.typography.titleLarge)
                val p = product
                if (p == null) {
                    val hits = remember(c.products,c.stock,c.prices,query) { ProductSearch(c.products,c.stock,c.prices,System.currentTimeMillis()).search(query,8) }
                    LabeledField("Name, code or barcode",query,{ query = it },"return-product-search",maxLength = 120)
                    Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        if (hits.isEmpty()) Text("No matching products",style = MaterialTheme.typography.bodyMedium)
                        hits.forEachIndexed { index,hit ->
                            ListRow(hit.product.name,"${hit.product.code} · ${hit.product.uomCode}","return-pick-$index",onClick = {
                                // A scanned case barcode counts in cases; otherwise the product's own unit.
                                product = hit.product
                                uom = hit.product.barcodeUnits.firstOrNull { it.barcode == query.trim() && (it.baseQuantity ?: 0) > 0 }?.uomCode ?: hit.product.uomCode })
                        }
                    }
                    SecondaryButton("Cancel",onClose,Modifier.testTag("return-line-cancel"))
                    return@Column
                }
                val units = ReturnRules.units(p)
                val unit = units.firstOrNull { it.uomCode == uom } ?: units.first()
                val base = VanRules.parseQuantity(quantity,unit.baseQuantity)
                val rule = policy.reason(reason)
                val line = ReturnLineInput(p.productId,unit.uomCode,base ?: 0,reason,disposition,lot.takeIf { it.isNotBlank() },expiry.takeIf { it.isNotBlank() })
                // Check this line together with the lines already on the return (duplicates, sold quantity).
                val problems = remember(line,c.returnDraft,c.returnFacts,c.customers,c.products) {
                    c.returnDraft?.let { d -> ReturnRules.evaluate(ReturnRequest(d.returnId,d.customer.outletId,d.originalSaleId,d.lines + line),c.returnContext()).issues
                        .filter { it.productId == p.productId } } ?: emptyList()
                }
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(p.name,style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("return-line-product"))
                    if (units.size > 1) {
                        Text("Counted in",style = MaterialTheme.typography.labelLarge)
                        units.forEach { u -> ReturnChoice(if (u.uomCode == p.uomCode) u.uomCode else "${u.uomCode} (${p.displayQuantity(u.baseQuantity)} ${p.uomCode})",
                            u.uomCode == unit.uomCode,"return-unit-${u.uomCode}") { uom = u.uomCode } }
                    }
                    LabeledField("Quantity ${unit.uomCode}",quantity,{ quantity = it },"return-quantity",numeric = true,maxLength = 24)
                    Text("Why is it returned?",style = MaterialTheme.typography.labelLarge)
                    policy.reasons.forEach { r -> ReturnChoice(r.label,r.code == reason,"return-reason-${r.code}") {
                        reason = r.code; if (r.dispositions.none { it.disposition == disposition }) disposition = r.dispositions.singleOrNull()?.disposition } }
                    rule?.let { r ->
                        Text("What happens to the goods?",style = MaterialTheme.typography.labelLarge)
                        r.dispositions.forEach { dr -> ReturnChoice(dr.disposition.label + if (dr.approvalRequired) " · needs approval" else "",
                            dr.disposition == disposition,"return-disposition-${dr.disposition.wire}") { disposition = dr.disposition } }
                    }
                    LabeledField(if (rule?.batchRequired == true) "Batch / lot number (required)" else "Batch / lot number (optional)",lot,{ lot = it },"return-lot",maxLength = 40)
                    LabeledField("Expiry date (optional, e.g. 2026-10-31)",expiry,{ expiry = it },"return-expiry",maxLength = 10)
                    if (quantity.isNotBlank() && (base == null || base == 0L)) Text("Enter a quantity above zero.",style = MaterialTheme.typography.bodyMedium)
                    problems.filter { it.problem != ReturnProblem.BAD_QUANTITY || quantity.isNotBlank() }
                        .filter { it.problem !in setOf(ReturnProblem.NO_REASON,ReturnProblem.NO_DISPOSITION) }
                        .forEach { Text(VanRules.returnMessage(it.problem,p.name),style = MaterialTheme.typography.bodyMedium) }
                }
                PrimaryBottomButton("Add to return",{ onAdd(line) },base != null && base > 0 && problems.isEmpty(),"return-line-add")
                SecondaryButton("Cancel",onClose,Modifier.testTag("return-line-cancel"))
            }
        }
    }
}

@Composable fun ReturnDoneScreen(c: VanController) {
    val receipt = c.lastReturn
    ScreenFrame("Return saved",action = "Done",actionTag = "return-done",onAction = { c.open(Page.HOME) }) {
        if (receipt == null) { Text("No return to show."); return@ScreenFrame }
        SectionCard("Return number") {
            Text(receipt.returnNumber.replaceFirst(Regex("-(?=[0-9A-F]{8}-[0-9]{4,}$)"),"-\n"),style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("return-number"))
            Text(receipt.customerName,style = MaterialTheme.typography.titleMedium)
            receipt.saleReceiptNumber?.let { Text("Bought on receipt $it",style = MaterialTheme.typography.bodyMedium) }
        }
        SectionCard(if (receipt.approvalReasons.isEmpty()) "No approval needed" else "Waiting for office approval") {
            Column(Modifier.semantics(mergeDescendants = true) {}.testTag("return-status"),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                if (receipt.approvalReasons.isEmpty()) Text("Recorded",style = MaterialTheme.typography.titleMedium)
                receipt.approvalReasons.forEach { Text(VanRules.approvalLabel(it),style = MaterialTheme.typography.bodyLarge) }
            }
        }
        SectionCard("Items") {
            receipt.lines.forEach { line ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("${line.unitQuantity} ${line.unit.uomCode} ${line.product.name}",style = MaterialTheme.typography.bodyLarge)
                    Text(listOfNotNull(line.reason.label,line.lotNumber?.let { "Batch $it" },line.expiryDate?.let { "Expiry\u00A0$it" }).joinToString(" · "),style = MaterialTheme.typography.bodyMedium)
                    Text(VanRules.stockEffectLabel(line.stockEffect,line.approvalRequired),style = MaterialTheme.typography.bodyMedium,fontWeight = FontWeight.SemiBold)
                }
            }
        }
        Text("Saved on this phone and the truck stock is updated. Sending returns to the office comes in a later update.",
            style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("return-saved-note"))
    }
}

/** One exclusive choice; the whole 56dp row is the target. */
@Composable private fun ReturnChoice(label: String, selected: Boolean, tag: String, onSelect: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected,onClick = onSelect,role = Role.RadioButton).testTag(tag),
        verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected,onClick = null,colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
        Text(label,Modifier.weight(1f).padding(start = 8.dp),style = MaterialTheme.typography.bodyLarge)
    }
}

private fun quantityLabel(p: Product, uomCode: String, base: Long): String {
    val unit = ReturnRules.units(p).firstOrNull { it.uomCode == uomCode } ?: return "${p.displayQuantity(base)} ${p.uomCode}"
    return if (unit.uomCode == p.uomCode) "${p.displayQuantity(base)} ${p.uomCode}"
        else "${VanRules.quantity(base,unit.baseQuantity)} ${unit.uomCode} · ${p.displayQuantity(base)} ${p.uomCode}"
}

private fun time(at: Long): String = Instant.ofEpochMilli(at).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("h:mm a"))
