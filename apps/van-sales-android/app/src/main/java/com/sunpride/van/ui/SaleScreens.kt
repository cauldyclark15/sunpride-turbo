package com.sunpride.van.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.rememberScrollState
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
import com.sunpride.van.data.*
import com.sunpride.van.pos.*

/**
 * VAN-011 sale and checkout. The sale screen is the cart for one customer; Checkout shows every problem in
 * plain words and enables Complete sale only when the cart passes the same rules the store re-checks while
 * saving. Nothing here talks to the network: the sale is complete once it is saved on this phone.
 */
@Composable fun SaleScreen(c: VanController) {
    val draft = c.sale
    var editing by remember { mutableStateOf<Product?>(null) }
    val now = remember(c.prices,c.stock,draft) { System.currentTimeMillis() }
    val priced = draft?.lines?.map { line ->
        val product = c.products.firstOrNull { it.productId == line.productId }
        val price = product?.let { PriceResolver.resolve(it,c.prices,now) }
        Triple(line,product,price?.let { CheckoutRules.lineTotal(it.unitPriceMinor,line.quantityBase,product.quantityScale)?.let { total -> price to total } })
    } ?: emptyList()
    val allPriced = priced.isNotEmpty() && priced.all { it.third != null } && priced.mapNotNull { it.third?.first?.currency }.distinct().size == 1
    val total = if (allPriced) priced.sumOf { it.third!!.second } else null
    ScreenFrame("Sale",c::back,action = "Checkout",actionTag = "checkout",enabled = !c.busy && draft != null && draft.lines.isNotEmpty(),
        onAction = { c.open(Page.CHECKOUT) },message = c.message,
        footer = when {
            draft == null || draft.lines.isEmpty() -> "No products yet"
            total != null -> "Total ${PosMoney.format(total,priced.first().third!!.first.currency)}"
            else -> "Total not ready: some products are priced by the office"
        }) {
        if (draft == null) { Text("No sale in progress."); return@ScreenFrame }
        SectionCard(VanRules.sourceLabel(draft.customer.source)) {
            Text(draft.customer.name,style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("sale-customer"))
            if (draft.customer.code.isNotBlank()) Text(draft.customer.code,style = MaterialTheme.typography.bodyMedium)
        }
        if (draft.lines.isEmpty()) Text("Add the products the customer is buying.",style = MaterialTheme.typography.bodyLarge)
        priced.forEachIndexed { index,(line,product,money) ->
            Surface(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}.clickable(enabled = !c.busy && product != null) { editing = product }.testTag("sale-line-$index"),
                color = MaterialTheme.colorScheme.surface,shape = SunprideTokens.shapes.small) {
                Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(16.dp),verticalAlignment = Alignment.CenterVertically,horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Column(Modifier.weight(1f),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(product?.name ?: "Product no longer on this phone",style = MaterialTheme.typography.titleMedium)
                        Text(product?.let { "${it.displayQuantity(line.quantityBase)} ${it.uomCode}" + (money?.let { (p,_) -> " × ${p.label()}" } ?: "") } ?: "",
                            style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(money?.let { (p,t) -> PosMoney.format(t,p.currency) } ?: "Priced by the office",
                        style = if (money != null) MaterialTheme.typography.titleMedium else MaterialTheme.typography.bodyMedium,
                        fontWeight = if (money != null) FontWeight.SemiBold else FontWeight.Normal,modifier = Modifier.testTag("sale-line-total-$index"))
                }
            }
        }
        SecondaryButton("Add product",c::pickProduct,Modifier.testTag("sale-add-product"),!c.busy)
        SecondaryButton("Cancel sale",c::cancelSale,Modifier.testTag("sale-cancel"),!c.busy)
    }
    editing?.let { product ->
        QuantityDialog(product,draft?.lines?.firstOrNull { it.productId == product.productId }?.quantityBase,allowZero = true,
            title = "Change quantity",onSave = { c.setSaleLine(product.productId,it); editing = null },onClose = { editing = null })
    }
}

@Composable fun CheckoutScreen(c: VanController) {
    var terms by remember { mutableStateOf(PaymentTerms.CASH) }
    var cash by remember { mutableStateOf("") }
    val payment = PaymentInput(terms,if (terms == PaymentTerms.CASH) VanRules.parseMoney(cash) else null)
    val result = remember(c.sale,c.products,c.stock,c.prices,c.customers,c.policy,c.trip,payment) { c.quote(payment) }
    // Totals come from the cart alone, so the seller sees the amount due before typing the cash.
    val due = remember(c.sale,c.products,c.stock,c.prices,c.customers,c.policy,c.trip) { c.quote(PaymentInput(PaymentTerms.CASH,CheckoutRules.MAX_MINOR))?.quote }
    val quote = result?.quote
    ScreenFrame("Checkout",c::back,action = if (c.busy) "Saving…" else "Complete sale",actionTag = "complete-sale",
        enabled = !c.busy && result?.ok == true,onAction = { quote?.let { c.completeSale(payment,it.totalMinor) } },message = c.message,
        footer = due?.let { "Total due ${PosMoney.format(it.totalMinor,it.currency)}" } ?: "Total not ready") {
        val draft = c.sale
        if (draft == null) { Text("No sale in progress."); return@ScreenFrame }
        SectionCard("Customer") { Text(draft.customer.name,style = MaterialTheme.typography.titleMedium) }
        // Problems first, so the reason Complete sale is off is visible without scrolling.
        val issues = result?.issues ?: emptyList()
        if (issues.isNotEmpty()) SectionCard("Before you can finish") {
            issues.forEachIndexed { index,issue ->
                Text(VanRules.checkoutMessage(issue.problem,issue.productId?.let { id -> c.products.firstOrNull { it.productId == id }?.name }),
                    style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("checkout-issue-$index"))
            }
        }
        due?.let { q ->
            SectionCard("Items") {
                q.lines.forEach { line ->
                    Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("${line.product.displayQuantity(line.quantityBase)} ${line.product.uomCode} ${line.product.name}",Modifier.weight(1f),style = MaterialTheme.typography.bodyLarge)
                        Text(PosMoney.format(line.totalMinor,q.currency),style = MaterialTheme.typography.bodyLarge)
                    }
                }
                Row(Modifier.fillMaxWidth()) {
                    Text("Total",Modifier.weight(1f),style = MaterialTheme.typography.titleLarge)
                    Text(PosMoney.format(q.totalMinor,q.currency),style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("checkout-total"))
                }
            }
        }
        SectionCard("Payment") {
            ChoiceRow("Cash",terms == PaymentTerms.CASH,"pay-cash") { terms = PaymentTerms.CASH }
            ChoiceRow("Credit (charge to the customer)",terms == PaymentTerms.CREDIT,"pay-credit") { terms = PaymentTerms.CREDIT }
            if (terms == PaymentTerms.CASH) {
                LabeledField("Cash received (₱)",cash,{ cash = it },"cash-received",numeric = true,maxLength = 18)
                quote?.let { Text("Change ${PosMoney.format(it.changeMinor,it.currency)}",style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("checkout-change")) }
            }
        }
        Text("The sale is saved on this phone first. It doesn't need signal.",style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable fun SaleDoneScreen(c: VanController) {
    val receipt = c.lastReceipt
    ScreenFrame("Sale saved",action = "Done",actionTag = "sale-done",onAction = { c.open(Page.HOME) }) {
        if (receipt == null) { Text("No sale to show."); return@ScreenFrame }
        SectionCard("Receipt number") {
            // Break before the device tag so the number never wraps mid-code on the 360dp handheld.
            Text(receipt.receiptNumber.replaceFirst(Regex("-(?=[0-9A-F]{8}-[0-9]{4,}$)"),"-\n"),style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("receipt-number"))
            Text(receipt.customerName,style = MaterialTheme.typography.titleMedium)
        }
        SectionCard("Items") {
            receipt.lines.forEach { line ->
                Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("${line.quantityLabel} ${line.uomCode} ${line.name}",Modifier.weight(1f),style = MaterialTheme.typography.bodyLarge)
                    Text(PosMoney.format(line.totalMinor,receipt.currency),style = MaterialTheme.typography.bodyLarge)
                }
            }
            Row(Modifier.fillMaxWidth()) {
                Text("Total",Modifier.weight(1f),style = MaterialTheme.typography.titleLarge)
                Text(PosMoney.format(receipt.totalMinor,receipt.currency),style = MaterialTheme.typography.titleLarge,modifier = Modifier.testTag("receipt-total"))
            }
            Text("Cash ${PosMoney.format(receipt.tenderedMinor,receipt.currency)} · Change ${PosMoney.format(receipt.changeMinor,receipt.currency)}",
                style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("receipt-change"))
        }
        Text("Saved on this phone and taken off the truck stock. Sending sales to the office comes in a later update.",
            style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("sale-saved-note"))
    }
}

/** One of several exclusive choices (payment terms): a radio button, the whole 56dp row is the target. */
@Composable private fun ChoiceRow(label: String, selected: Boolean, tag: String, onSelect: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).selectable(selected,onClick = onSelect,role = Role.RadioButton).testTag(tag),
        verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected,onClick = null,colors = RadioButtonDefaults.colors(selectedColor = MaterialTheme.colorScheme.secondary))
        Text(label,Modifier.weight(1f).padding(start = 8.dp),style = MaterialTheme.typography.bodyLarge)
    }
}

/** Quantity in the product's own unit; [allowZero] lets the sale screen remove a line. */
@Composable fun QuantityDialog(product: Product, initialBase: Long?, allowZero: Boolean = false, title: String = "Add to sale",
    onSave: (Long) -> Unit, onClose: () -> Unit) {
    var quantity by remember { mutableStateOf(initialBase?.let { product.displayQuantity(it) } ?: "") }
    val base = VanRules.parseQuantity(quantity,product.quantityScale)
    val valid = base != null && (base > 0 || allowZero && initialBase != null)
    Dialog(onDismissRequest = onClose,properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(16.dp).imePadding().navigationBarsPadding(),shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(title,style = MaterialTheme.typography.titleLarge)
                Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(product.name,style = MaterialTheme.typography.titleMedium)
                    LabeledField("Quantity ${product.uomCode}",quantity,{ quantity = it },"sale-quantity",numeric = true,maxLength = 24)
                    if (allowZero && initialBase != null) Text("Enter 0 to remove it from the sale.",style = MaterialTheme.typography.bodyMedium)
                }
                PrimaryBottomButton(if (base == 0L) "Remove" else "Save",{ onSave(base!!) },valid,"save-quantity")
                SecondaryButton("Cancel",onClose,Modifier.testTag("cancel-quantity"))
            }
        }
    }
}
