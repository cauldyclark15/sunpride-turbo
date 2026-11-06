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
import com.sunpride.van.selling.SellingPlace
import com.sunpride.van.selling.QuickCash
import androidx.compose.runtime.saveable.rememberSaveable

/**
 * VAN-011 sale and checkout, rebuilt for speed (IP-HH1). The sale screen is a product grid with a cart bar on every view; the cart,
 * the search palette and the quantity keypad open on top of it, and the scanner adds without a dialog. Checkout shows every problem in
 * plain words and enables Complete sale only when the cart passes the same rules the store re-checks while saving. Nothing here talks
 * to the network: the sale is complete once it is saved on this phone.
 */
@Composable fun SaleScreen(c: VanController) {
    val draft = c.sale
    var cartOpen by rememberSaveable { mutableStateOf(false) }
    var discounting by remember { mutableStateOf(false) }
    var changingPrice by remember { mutableStateOf(false) }
    var claiming by remember { mutableStateOf(false) }
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) { while (true) { kotlinx.coroutines.delay(60_000); now = System.currentTimeMillis() } }
    if (draft == null) { ScreenFrame("Sale", c::back) { Text("No sale in progress.") }; return }
    val quote = remember(c.prices,c.promotions,c.stock,c.customers,c.policy,draft) { c.cartQuote() }
    val index = remember(c.products,c.stock,c.prices,now,draft.customer) { ProductSearch(c.products,c.stock,c.prices,now,draft.customer) }
    val priced = draft.lines.map { line ->
        val product = c.products.firstOrNull { it.productId == line.productId }
        Triple(line,product,quote?.lines?.firstOrNull { it.product.productId == line.productId })
    }
    // Without a whole-cart quote (a line unpriced, or a promotion needs the office) each line still shows its own
    // customer price, so the seller sees which product is the problem.
    val rows = priced.map { (line,product,money) ->
        val own = product?.let { PriceResolver.resolve(it,c.prices,now,draft.customer) }
        val currency = quote?.currency ?: own?.currency ?: "PHP"
        CartRowUi(line.productId,product,money?.quantityBase ?: line.quantityBase,
            (money?.unitPriceMinor ?: own?.unitPriceMinor)?.let { PosMoney.format(it,currency) + " each" },
            money?.let { PosMoney.format(it.totalMinor,currency) }
                ?: product?.let { p -> own?.let { pr -> CheckoutRules.lineTotal(pr.unitPriceMinor,line.quantityBase,p.quantityScale)?.let { PosMoney.format(it,pr.currency) } } } ?: "Office price",
            product?.let { p -> buildList {
                money?.promotion?.let { add("${it.name}${if (money.discountMinor > 0) " · discount ${PosMoney.format(money.discountMinor,currency)}" else ""}") }
                money?.let { q -> if (q.freeBase > 0L) add("Free ${p.displayQuantity(q.freeBase)} ${p.uomCode}") }
            }.joinToString(" · ").ifEmpty { null } },
            c.stock.firstOrNull { it.productId == line.productId }?.availableBase ?: 0L)
    }
    val totalLabel = when { draft.lines.isEmpty() -> "₱0.00"; quote != null -> PosMoney.format(quote.totalMinor,quote.currency); else -> "Not ready" }
    val canCharge = !c.busy && c.retailLoaded && (c.retailCall == null || c.retailSaved) && draft.lines.isNotEmpty()
    SellingBrowse(
        title = "Sale", subtitle = draft.customer.name + (if (draft.customer.code.isNotBlank()) " · ${draft.customer.code}" else ""), onBack = c::back, place = SellingPlace.VAN,
        search = index, scanProducts = c.products,
        currentLines = { c.sale?.lines ?: emptyList() }, onSetLine = { id,base -> if (!c.busy) c.setSaleLine(id,base) },
        rows = rows, totalLabel = totalLabel, chargeEnabled = canCharge, onCharge = { c.open(Page.CHECKOUT) },
        cartOpen = cartOpen, onCartOpen = { cartOpen = it }, busy = c.busy,
        cashierName = c.seller?.name, roleLabel = "Van seller",
        message = c.message ?: when {
            !c.retailLoaded -> "Loading the downloaded MSL…"
            draft.lines.isNotEmpty() && quote == null -> claimIssue(c,draft) ?: "Total not ready: some products are priced by the office"
            else -> null
        },
        header = c.retailCall?.let { call -> {
            SectionCard("Availability · required") {
                com.sunpride.retail.RetailAvailabilityStep(call,c.busy,c.retailSaved) { answers,quantities -> c.saveRetail(answers,quantities) }
            }
        } },
        cartExtras = {
            val manualUsed = draft.manualDiscount?.let { it.lineMinor.isNotEmpty() || it.basketMinor > 0L } == true || draft.priceOverride?.unitMinor?.isNotEmpty() == true
            // IP-HH2: Senior / PWD / Solo parent / Athlete / Uniformed; it replaces the manual discount and the price exception on this sale.
            SecondaryButton(draft.claim?.let { "${it.type.label} discount · ${it.holderName.trim()}" } ?: "Senior, PWD or other discount",{ claiming = true },Modifier.testTag("sale-claim"),!c.busy && draft.lines.isNotEmpty() && (draft.claim != null || !manualUsed))
            draft.claim?.let { claim -> ClaimSummary(claim,quote?.legal,c.claimPreview,null) }
            SecondaryButton("Line & basket discounts",{ discounting = true },Modifier.testTag("sale-discounts"),!c.busy && draft.lines.isNotEmpty() && draft.claim == null)
            SecondaryButton("Price exception",{ changingPrice = true },Modifier.testTag("sale-price-exception"),!c.busy && draft.lines.isNotEmpty() && draft.claim == null)
            if (draft.priceOverride != null) FinancialApprovalCard(c,"price")
            quote?.takeIf { ManualDiscounts.amount(it.lines) > 0L }?.let { DiscountApprovalCard(c,it) }
            SecondaryButton("Cancel sale",c::cancelSale,Modifier.testTag("sale-cancel"),!c.busy)
        })
    if (claiming) ClaimSheet(items = draft.lines.map { l -> l.productId to (c.products.firstOrNull { it.productId == l.productId }?.name ?: "Item") },initial = draft.claim,
        onApply = { c.setClaim(it); claiming = false },onRemove = if (draft.claim != null) ({ c.setClaim(null); claiming = false }) else null,onClose = { claiming = false })
    if (discounting) DiscountDialog(c) { discounting = false }
    if (changingPrice) PriceOverrideDialog(c) { changingPrice = false }
}

@Composable fun CheckoutScreen(c: VanController) {
    val methods = c.paymentMethods
    val cashMethod = methods.firstOrNull { it.kind == PaymentKind.CASH }
    val otherMethods = methods.filter { it.kind != PaymentKind.CASH }
    // IP-INT3: the office takes cash plus a non-credit tender; credit stays a whole-sale choice (collections and aging follow the sale).
    val splitMethods = otherMethods.filter { it.kind != PaymentKind.CREDIT }
    // IP-HH2: cash plus one more tender, only when the office's server says it takes a split sale.
    val splitAvailable = c.policy?.splitTender == true && cashMethod != null && splitMethods.isNotEmpty()
    var methodCode by remember { mutableStateOf(methods.firstOrNull { it.kind == PaymentKind.CASH }?.code ?: methods.first().code) }
    val splitOn = splitAvailable && methodCode == SPLIT_ID
    val method = methods.firstOrNull { it.code == methodCode } ?: methods.first()
    var tendered by remember { mutableStateOf<Long?>(null) }
    // EXACT only fills Tendered with what is due (and follows it if a discount changes it). A bill turns it off. It never saves.
    var exact by remember { mutableStateOf(false) }
    var claiming by remember { mutableStateOf(false) }
    var discounting by remember { mutableStateOf(false) }
    var reference by remember { mutableStateOf("") }
    var splitCode by remember { mutableStateOf(splitMethods.firstOrNull()?.code) }
    var splitText by remember { mutableStateOf("") }
    var splitRef by remember { mutableStateOf("") }
    val splitMethod = splitMethods.firstOrNull { it.code == splitCode }
    val splitMinor = VanRules.parseMoney(splitText)
    // Credit sold here and references already used (VAN-012); the store re-checks both while saving.
    LaunchedEffect(c.sale?.saleId) { c.refreshPaymentFacts() }
    LaunchedEffect(c.sale?.saleId, c.sale?.claim, c.sale?.lines) { if (c.sale?.claim != null) c.previewClaim() }
    var approvalExpiryTick by remember { mutableIntStateOf(0) }
    val approvalTokens=listOfNotNull(c.sale?.manualDiscount?.approval,c.sale?.priceOverride?.authorization?.approval,c.sale?.creditOverride?.approval)
    LaunchedEffect(approvalTokens,c.policy,approvalExpiryTick){
        val now=System.currentTimeMillis()
        val times=approvalTokens.mapNotNull{token->runCatching{org.json.JSONObject(java.util.Base64.getUrlDecoder().decode(token.split('.')[1]).toString(Charsets.UTF_8)).getLong("expiresAt")}.getOrNull()}.toMutableList()
        runCatching{val rules=org.json.JSONObject(checkNotNull(c.policy?.fiscalJson)).getJSONObject("authority").getJSONArray("rules");for(i in 0 until rules.length()){val rule=rules.getJSONObject(i);times.add(rule.getLong("effectiveFrom"));if(!rule.isNull("effectiveTo"))times.add(rule.getLong("effectiveTo"))}}
        c.sale?.let{com.sunpride.van.pos.SapCreditExceptions.state(it.saleId,c.saleContext(now))}?.takeIf{!it.isNull("expiresAt")}?.let{times.add(it.getLong("expiresAt"))}
        times.filter{it>now}.minOrNull()?.let{kotlinx.coroutines.delay((it-now).coerceAtMost(86_400_000L)+1);approvalExpiryTick++}
    }
    // Totals come from the cart alone, so the seller sees the amount due before entering the payment.
    val due = remember(c.sale,c.products,c.stock,c.prices,c.customers,c.policy,c.trip) { c.cartQuote() }
    val exactCash: Long? = due?.let { d -> if (splitOn) splitMinor?.let { o -> d.totalMinor - o } else d.totalMinor }
    val tenderedNow = QuickCash.effectiveTenderedMinor(exact,exactCash,tendered)
    val payment = if (splitOn) PaymentInput(checkNotNull(cashMethod).code,tenderedNow) else PaymentInput(method.code,if (method.kind == PaymentKind.CASH) tenderedNow else null,reference.takeIf { method.referenceRequired })
    val splitPayment = if (splitOn && splitMethod != null && splitMinor != null) SplitPayment(splitMethod.code,splitMinor,splitRef.takeIf { splitMethod.referenceRequired }) else null
    // A split that is not filled in yet is not a sale: the buttons below are the answer.
    val result = remember(c.sale,c.products,c.stock,c.prices,c.customers,c.policy,c.trip,c.paymentFacts,payment,splitPayment,splitOn,approvalExpiryTick) { if (splitOn && splitPayment == null) null else c.quote(payment,splitPayment) }
    val quote = result?.quote
    // EXACT: the customer hands over exactly the total (or, split, exactly the cash part), so the sale can be saved with that one tap.
    val exactPayment = remember(due?.totalMinor,cashMethod?.code,splitOn,splitMinor) { due?.let { d -> cashMethod?.let { PaymentInput(it.code,if (splitOn) splitMinor?.let { o -> d.totalMinor - o } else d.totalMinor) } } }
    val exactResult = remember(c.sale,c.products,c.stock,c.prices,c.customers,c.policy,c.trip,c.paymentFacts,exactPayment,splitPayment,splitOn,approvalExpiryTick) { exactPayment?.takeIf { it.tenderedMinor != null && (!splitOn || splitPayment != null) }?.let { c.quote(it,splitPayment) } }
    val draft = c.sale
    if (draft == null) { ScreenFrame("Payment", c::back) { Text("No sale in progress.") }; return }
    val view = if (splitOn) due?.let { SplitTenders.view(it.totalMinor,splitMinor ?: 0L,tenderedNow ?: 0L) } else null
    val preview = c.claimPreview
    // Cash needs a tender: until one is chosen that is not a "problem", the buttons below are the answer.
    val issues = (result?.issues ?: emptyList()).filterNot { (method.kind == PaymentKind.CASH || splitOn) && tenderedNow == null && it.problem == CheckoutProblem.CASH_MISSING }.map { issue ->
        VanRules.checkoutMessage(issue.problem,issue.productId?.let { id -> c.products.firstOrNull { it.productId == id }?.name })
    } + listOfNotNull(
        (preview as? VanController.ClaimPreview.Differs)?.let { "The office works out ${com.sunpride.van.selling.Peso.format(it.serverMinor)} for this discount; this phone ${com.sunpride.van.selling.Peso.format(it.phoneMinor)}. Sync to refresh prices and tax, then try again." },
        if (splitOn && (splitMinor == null || due != null && !SplitTenders.partsValid(due.totalMinor,splitMinor))) "Enter what the other tender pays: more than ₱0 and less than the total." else null)
    val blocked = preview is VanController.ClaimPreview.Differs
    val choices = methods.map { TenderChoice(it.code,it.label,when (it.kind) { PaymentKind.CASH -> TenderKind.CASH; PaymentKind.OTHER -> TenderKind.OTHER; PaymentKind.CREDIT -> TenderKind.CREDIT }) } +
        (if (splitAvailable) listOf(TenderChoice(SPLIT_ID,"Cash + other",TenderKind.CASH)) else emptyList())
    val manualUsed = draft.manualDiscount?.let { it.lineMinor.isNotEmpty() || it.basketMinor > 0L } == true || draft.priceOverride?.unitMinor?.isNotEmpty() == true
    PaymentStep(
        title = "Payment", subtitle = draft.customer.name + (if (draft.customer.code.isNotBlank()) " · ${draft.customer.code}" else ""),
        totalMinor = due?.totalMinor, choices = choices,
        selectedId = if (splitOn) SPLIT_ID else method.code, onSelect = { methodCode = it; tendered = null; exact = false }, tenderedMinor = tenderedNow, onTendered = { exact = false; tendered = it },
        issues = issues, cashDueMinor = view?.cashDueMinor,
        saving = c.busy, canPay = !c.busy && !blocked && result?.ok == true, exactEnabled = !c.busy && !blocked && exactResult?.ok == true, exactActive = exact,
        // EXACT only fills Tendered = Total (change ₱0.00). The seller can still add a discount, then must press Complete.
        onExact = { if (exactPayment != null && exactResult?.ok == true) { exact = true; tendered = null } },
        onPay = { quote?.let { c.completeSale(payment,it.totalMinor,splitPayment) } }, onBack = c::back, message = c.message,
        options = listOf(
            // IP-HH2: Senior / PWD / Solo parent / Athlete / Uniformed replaces the manual discount and the price exception on this sale.
            PayOption("Discount",draft.claim?.type?.label,"sale-claim",{ claiming = true },enabled = !c.busy && draft.lines.isNotEmpty() && (draft.claim != null || !manualUsed),active = draft.claim != null),
            PayOption("Line discount",if (manualUsed) "Applied" else null,"sale-discounts",{ discounting = true },enabled = !c.busy && draft.lines.isNotEmpty() && draft.claim == null,active = manualUsed))) {
        draft.claim?.let { claim -> ClaimSummary(claim,due?.legal,preview,null) }
        if (splitOn) SectionCard("Second tender") {
            splitMethods.forEach { m ->
                val on = m.code == splitCode
                OutlinedButton({ splitCode = m.code },Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("split-method-${m.code}"),shape = SunprideTokens.shapes.small,
                    colors = if (on) ButtonDefaults.outlinedButtonColors(containerColor = SunprideTokens.barInk,contentColor = androidx.compose.ui.graphics.Color.White) else ButtonDefaults.outlinedButtonColors()) { Text(m.label) }
            }
            LabeledField("${splitMethod?.label ?: "Other tender"} pays (₱)",splitText,{ splitText = it },"split-amount",numeric = true,maxLength = 14)
            if (splitMethod?.referenceRequired == true) LabeledField(splitMethod.referenceLabel ?: "Reference number",splitRef,{ splitRef = it },"split-reference",maxLength = 40)
            view?.let { v ->
                Text("Cash due ${com.sunpride.van.selling.Peso.format(v.cashDueMinor)}",style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("split-cash-due"))
                Text(if (v.remainingMinor > 0) "Still to pay ${com.sunpride.van.selling.Peso.format(v.remainingMinor)}" else "Paid in full",style = MaterialTheme.typography.titleMedium,fontWeight = FontWeight.Bold,modifier = Modifier.testTag("split-remaining"))
                if (v.changeMinor > 0) Text("Change ${com.sunpride.van.selling.Peso.format(v.changeMinor)}, from the cash only",style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("split-change"))
            }
            Text("Choose the cash the customer hands over above. Change only ever comes from cash.",style = MaterialTheme.typography.bodyMedium)
        } else when (method.kind) {
            PaymentKind.CASH -> {}
            PaymentKind.OTHER -> SectionCard(method.label) {
                if (method.referenceRequired) LabeledField(method.referenceLabel ?: "Reference number",reference,{ reference = it },"payment-reference",maxLength = 40)
                due?.let { Text("Amount ${PosMoney.format(it.totalMinor,it.currency)} — the full total, no change.",style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("payment-amount")) }
                Text("The office confirms this payment later. The sale is saved now.",style = MaterialTheme.typography.bodyMedium)
            }
            PaymentKind.CREDIT -> SectionCard(method.label) {
                SaleCreditPanel(c){approvalExpiryTick++}
                FinancialApprovalCard(c,"credit")
                quote?.payment?.dueDate?.let { Text("Due $it",style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("credit-due")) }
            }
        }
        due?.let { q ->
            SectionCard("Items") {
                q.lines.forEach { line ->
                    Column(Modifier.fillMaxWidth(),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("${com.sunpride.van.selling.Quantities.label(line.product,line.quantityBase)} ${line.product.name}",Modifier.weight(1f),style = MaterialTheme.typography.bodyLarge)
                            Text(PosMoney.format(line.totalMinor,q.currency),style = MaterialTheme.typography.bodyLarge,fontWeight = FontWeight.Bold)
                        }
                        line.priceListCode?.let { Text("Price: $it",style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        line.promotion?.let { p -> Text("${p.name}${if (line.discountMinor > 0) " · discount ${PosMoney.format(line.discountMinor,q.currency)}" else ""}",style = MaterialTheme.typography.bodyMedium) }
                        if(line.privilegeDiscountMinor>0L)Text("${draft.claim?.type?.label ?: "Discount"} −${PosMoney.format(line.privilegeDiscountMinor,q.currency)}",style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("line-privilege"))
                        if(line.manualDiscountMinor>0L)Text("Manual reduction ${PosMoney.format(line.manualDiscountMinor,q.currency)}",style=MaterialTheme.typography.bodyMedium)
                        if (line.freeBase > 0L) Text("Free ${line.product.displayQuantity(line.freeBase)} ${line.product.uomCode}",style = MaterialTheme.typography.bodyMedium)
                    }
                }
                if(q.earnedMinor > 0) Text("Quoted deferred rebate ${PosMoney.format(q.earnedMinor,q.currency)}. Not deducted from this payment; the office confirms and settles it separately.",style = MaterialTheme.typography.bodyMedium,modifier = Modifier.testTag("deferred-rebate"))
            }
        }
        Text("The sale is saved on this phone first. It doesn't need signal.",style = MaterialTheme.typography.bodyMedium)
    }
    if (claiming) ClaimSheet(items = draft.lines.map { l -> l.productId to (c.products.firstOrNull { it.productId == l.productId }?.name ?: "Item") },initial = draft.claim,
        onApply = { c.setClaim(it); claiming = false },onRemove = if (draft.claim != null) ({ c.setClaim(null); claiming = false }) else null,onClose = { claiming = false })
    if (discounting) DiscountDialog(c) { discounting = false }
}
private const val SPLIT_ID = "split"

/** IP-HH2: why a cart with a discount claim has no total (the claim's own problem in plain words), or null. */
private fun claimIssue(c: VanController, draft: SaleDraft): String? {
    if (draft.claim == null) return null
    val issues = c.quote(PaymentInput(PaymentMethod.CASH.code,CheckoutRules.MAX_MINOR))?.issues.orEmpty()
    val i = issues.firstOrNull { it.problem == CheckoutProblem.DISCOUNT_TAX_UNKNOWN || it.problem == CheckoutProblem.DISCOUNT_CLAIM_INVALID || it.problem == CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL } ?: return null
    return VanRules.checkoutMessage(i.problem,i.productId?.let { id -> c.products.firstOrNull { it.productId == id }?.name })
}

@Composable fun SaleDoneScreen(c: VanController) {
    val receipt = c.lastReceipt
    if (receipt == null) { ScreenFrame("Sale saved",action = "Done",actionTag = "sale-done",onAction = { c.open(Page.HOME) }) { Text("No sale to show.") }; return }
    val customer = c.selectedCustomer
    val split = receipt.paymentMethod == "split"
    val received = if (split) receipt.totalMinor + receipt.changeMinor else if (receipt.paymentKind == PaymentKind.CASH) receipt.tenderedMinor else receipt.totalMinor
    CompleteStep(
        title = "Sale saved · ${receipt.customerName}", receivedLabel = PosMoney.format(received,receipt.currency), totalLabel = PosMoney.format(receipt.totalMinor,receipt.currency),
        changeLabel = PosMoney.format(if (split || receipt.paymentKind == PaymentKind.CASH) receipt.changeMinor else 0L,receipt.currency),
        headline = "Saved on this phone", onNewSale = { if (customer != null) c.startSale(customer) else c.open(Page.HOME) },
        secondaryLabel = "Done", onSecondary = { c.open(Page.HOME) }, message = c.message) {
        SectionCard("Receipt number") {
            // Break before the device tag so the number never wraps mid-code on the 360dp handheld.
            Text(receipt.receiptNumber.replaceFirst(Regex("-(?=[0-9A-F]{8}-[0-9]{4,}$)"),"-\n"),style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("receipt-number"))
            val payLines = com.sunpride.van.printing.ReceiptDiscounts.paymentLines(receipt.fiscalJson?.let { org.json.JSONObject(it) }) { PosMoney.format(it,receipt.currency) }
            Text(if (split && payLines.isNotEmpty()) payLines.joinToString("\n") { "${it.first.trim()} ${it.second}" } else when (receipt.paymentKind) {
                PaymentKind.CASH -> "Cash ${PosMoney.format(receipt.tenderedMinor,receipt.currency)} · Change ${PosMoney.format(receipt.changeMinor,receipt.currency)}"
                else -> "${receipt.paymentLabel} ${PosMoney.format(receipt.totalMinor,receipt.currency)}"
            },style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("receipt-method"))
            Text(VanRules.paymentStateLabel(receipt.paymentStatus,receipt.dueDate),style = MaterialTheme.typography.titleMedium,modifier = Modifier.testTag("receipt-payment-state"))
            receipt.reference?.let { Text("Reference $it",style = MaterialTheme.typography.bodyLarge,modifier = Modifier.testTag("receipt-reference")) }
        }
        ReceiptPrintCard(c,receipt.saleId)
        SectionCard("Items") {
            receipt.lines.forEach { line ->
                Column(Modifier.fillMaxWidth(),verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text("${line.quantityLabel} ${line.uomCode} ${line.name}",Modifier.weight(1f),style = MaterialTheme.typography.bodyLarge)
                        Text(PosMoney.format(line.totalMinor,receipt.currency),style = MaterialTheme.typography.bodyLarge,fontWeight = FontWeight.Bold)
                    }
                    line.priceListCode?.let { Text("Price: $it",style = MaterialTheme.typography.bodyMedium,color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    line.promotionCode?.let { Text("Promo $it${if (line.discountMinor > 0) " · discount ${PosMoney.format(line.discountMinor,receipt.currency)}" else ""}",style = MaterialTheme.typography.bodyMedium) }
                    if (line.freeBase > 0L) Text("Free ${line.freeQuantityLabel ?: line.freeBase} ${line.uomCode}",style = MaterialTheme.typography.bodyMedium)
                }
            }
            receipt.lines.mapNotNull { it.priceListCode }.distinct().takeIf { it.isNotEmpty() }?.let { Text("Prices: ${it.joinToString(", ")}",style = MaterialTheme.typography.bodyMedium) }
            com.sunpride.van.printing.ReceiptDiscounts.claimLines(receipt.fiscalJson?.let { org.json.JSONObject(it) }) { PosMoney.format(it,receipt.currency) }.forEach { (label,amount) ->
                Text(if (amount != null) "$label $amount" else label,style = MaterialTheme.typography.bodyLarge,fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("receipt-claim"))
            }
        }
        Text("Taken off the truck stock. It is sent to the office at the next sync.",style = MaterialTheme.typography.bodyMedium)
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
