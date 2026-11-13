package com.sunpride.van.ui

import androidx.compose.material3.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import com.sunpride.van.storepos.*
import com.sunpride.van.pos.*
import com.sunpride.van.data.Product
import com.sunpride.van.printing.PrintOutcome
import com.sunpride.van.printing.ReprintRules
import com.sunpride.van.selling.*
import androidx.activity.compose.BackHandler
import com.sunpride.van.evidence.DamageCameraScreen
import kotlinx.coroutines.launch
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
import com.sunpride.van.storepos.StoreStockRefresh
import java.math.BigDecimal

private fun pesos(n:Long)= "₱"+BigDecimal.valueOf(n,2).setScale(2).toPlainString()
private fun quantity(text:String,scale:Long):Long?=runCatching{BigDecimal(text).multiply(BigDecimal.valueOf(scale)).longValueExact().also {require(it>=0)}}.getOrNull()

/** The sale that was just saved, for the Complete step. */
private data class CompletedStoreSale(val saleId: String, val receivedMinor: Long, val totalMinor: Long, val changeMinor: Long)

/**
 * F-R03 same APK, physical scanner and pure checkout/pricing/promotion engine. IP-HH1: the same selling kit as the van — grid,
 * palette, cart bar, steppers, Payment and Complete steps — with the store's tenders, loyalty and employee discount kept on Payment.
 */
@Composable fun StoreSaleScreen(c:VanController){
    val config=c.storePos.config ?: return
    var now by remember{mutableLongStateOf(System.currentTimeMillis())}
    LaunchedEffect(Unit){while(true){kotlinx.coroutines.delay(60_000);now=System.currentTimeMillis()}}
    var cart by remember(config.modeVersionId){mutableStateOf(emptyList<CartLine>())}
    // IP-INT3FIX: pick up stock the office received while this grid is open; never in the middle of a basket.
    LaunchedEffect(Unit){if(cart.isEmpty())c.refreshStoreStock();while(true){kotlinx.coroutines.delay(StoreStockRefresh.EVERY_MS);if(cart.isEmpty())c.refreshStoreStock()}}
    var saleId by remember(config.modeVersionId){mutableStateOf(UUID.randomUUID().toString())}
    var flow by remember{mutableStateOf(SellFlow())}
    fun send(e:SellEvent){flow=SellFlowReducer.reduce(flow,e)}
    var tender by remember {mutableStateOf("cash")}
    var tenderedMinor by remember {mutableStateOf<Long?>(null)}
    // EXACT only marks "tendered = total"; it follows the total if a discount changes it, and a bill turns it off. It never saves.
    var exact by remember {mutableStateOf(false)}
    var cashShare by remember {mutableStateOf("")}
    var cardShare by remember {mutableStateOf("")}
    var received by remember {mutableStateOf("")}
    var walletRef by remember {mutableStateOf("")}
    var cardRef by remember {mutableStateOf("")}
    var phone by remember {mutableStateOf("")}
    var points by remember {mutableStateOf("")}
    var employee by remember {mutableStateOf(false)}
    var pin by remember {mutableStateOf("")}
    var more by remember {mutableStateOf(false)}
    // IP-HH2: Senior / PWD / Solo parent / Athlete / Uniformed. It replaces the employee discount and points on this sale.
    var claim by remember {mutableStateOf<com.sunpride.van.selling.DiscountClaim?>(null)}
    var claiming by remember {mutableStateOf(false)}
    var notice by remember {mutableStateOf<String?>(null)}
    var completed by remember {mutableStateOf<CompletedStoreSale?>(null)}
    var savedFlag by remember {mutableStateOf(false)}
    val scope=rememberCoroutineScope()
    val context=remember(config,c.storePos.rows,now){runCatching{StoreCheckout.context(config,c.storePos.rows,now)}}
    val products=remember(config){StoreCheckout.products(config)}
    val index=remember(context,products,now){
        val ctx=context.getOrNull()
        ProductSearch(products,ctx?.stock?:emptyList(),ctx?.prices?:emptyList(),now,ctx?.customers?.singleOrNull())
    }
    val evaluation=runCatching{StoreCheckout.quote(config,c.storePos.rows,cart,now,claim)}
    val quote=evaluation.getOrNull()
    val pointCount=if(points.isBlank())0L else points.toLongOrNull()?.takeIf {it>=0}
    val validRedemption=pointCount==0L || pointCount!=null&&pointCount<=StoreCheckout.availablePoints(config,c.storePos.rows)&&runCatching{StoreCheckout.normalizePhone(phone)}.getOrNull()==config.details.optJSONObject("customerLookup")?.optString("phone")
    val total=quote?.takeIf {pointCount!=null&&validRedemption}?.let {runCatching{StoreCheckout.total(config,it.totalMinor,employee,checkNotNull(pointCount))}.getOrNull()}
    val cashPart=when(tender){"cash"->total;"split"->VanRules.parseMoney(cashShare);else->null}
    val tenderedNow=QuickCash.effectiveTenderedMinor(exact,total,tenderedMinor)
    fun buildTenders(n:Long,tendered:Long?):List<StoreTransactions.Tender>?=runCatching {
        val cash=when(tender){"cash"->n;"split"->checkNotNull(VanRules.parseMoney(cashShare));else->0}
        val card=when(tender){"card"->n;"split"->VanRules.parseMoney(cardShare)?:0;else->0}
        val wallet=when(tender){"gcash"->n;"split"->n-cash-card;else->0}
        require(cash>=0&&card>=0&&wallet>=0)
        buildList {
            if(cash>0)add(StoreTransactions.Tender("cash",cash,tendered=tendered?:cash))
            if(wallet>0){require(walletRef.length>=2);add(StoreTransactions.Tender("gcash",wallet,walletRef))}
            if(card>0){require(cardRef.length>=2);add(StoreTransactions.Tender("card",card,cardRef))}
        }.also {require(n==0L||it.isNotEmpty())}
    }.getOrNull()
    val splitCashTendered=VanRules.parseMoney(received)
    val tenders=total?.let{n->buildTenders(n,if(tender=="split")splitCashTendered else tenderedNow)}
    val cashReady=when(tender){"cash"->tenderedNow!=null&&total!=null&&tenderedNow>=total;else->true}
    // IP-HOLD: park this cart for the next customer; recall it later (prices and stock are checked again).
    LaunchedEffect(Unit){c.refreshHeld()}
    val storeHeld=HeldCartsUi(c.heldOf(com.sunpride.van.pos.HeldCartRules.SURFACE_STORE).size,c.heldOf(com.sunpride.van.pos.HeldCartRules.SURFACE_STORE),
        onHold={name,note,lines,totalLabel,done->c.holdCart(com.sunpride.van.pos.HeldCartRules.SURFACE_STORE,name,note,null,lines,totalLabel){err->
            // NF-R5V-3: the claim and the customer's extras stay with the held cart's customer, never the next cart.
            if(err==null){claim=null;claiming=false;employee=false;pin="";points="";phone="";saleId=UUID.randomUUID().toString()};done(err)}},onRecalled=c::heldRecalled,onDiscard=c::discardHeld)
    val setupProblem=remember(config){StoreCheckout.setupProblem(config)}
    val enabledTenders=remember(config){StoreCheckout.enabledTenders(config)}
    val canPay=setupProblem==null&&total!=null&&tenders!=null&&cashReady&&c.storePos.shift!=null&&!c.busy&&!c.onHold&&(!employee||pin.length>=6)
    /** One save path for Exact and the Complete button: nothing about the payload changes from the old Save sale. */
    fun pay(withTenders:List<StoreTransactions.Tender>,n:Long){
        send(SellEvent.PayTapped);savedFlag=false
        val cashTender=withTenders.firstOrNull{it.method=="cash"}
        val receivedMinor=cashTender?.let{it.tendered?:it.amount}?:n
        val change=cashTender?.let{maxOf(0L,(it.tendered?:it.amount)-it.amount)}?:0L
        val id=saleId
        c.saveStoreSale(id,cart,withTenders,n,phone.takeIf{it.isNotBlank()},if(employee)pin else null,checkNotNull(pointCount),onSaved={
            savedFlag=true;completed=CompletedStoreSale(id,receivedMinor,n,change);send(SellEvent.SaleSaved)
        },claim=claim);pin=""
    }
    // A refused save (the controller shows why) re-enables the buttons.
    LaunchedEffect(c.busy){if(!c.busy&&flow.saving&&!savedFlag)send(SellEvent.SaveFailed)}
    BackHandler(enabled=flow.step==SellStep.PAYMENT&&!flow.saving){send(SellEvent.BackTapped)}
    // The bottom bar hides while money is being taken (Payment and Complete share this page with the grid).
    SideEffect{c.navHidden=flow.step==SellStep.PAYMENT||flow.step==SellStep.COMPLETE}
    DisposableEffect(Unit){onDispose{c.navHidden=false}}

    fun newSale(){
        c.startNewStoreSale()
        cart=emptyList();saleId=UUID.randomUUID().toString();tender="cash";tenderedMinor=null;exact=false;cashShare="";cardShare="";received="";walletRef="";cardRef="";phone="";points="";employee=false;pin="";more=false;claim=null;claiming=false;notice=null;completed=null;savedFlag=false
        send(SellEvent.NewSaleTapped)
    }
    val currency="PHP"
    val rows=cart.map{line->
        val product=products.firstOrNull{it.productId==line.productId}
        val q=quote?.lines?.firstOrNull{it.product.productId==line.productId}
        val own=product?.let{PriceResolver.resolve(it,context.getOrNull()?.prices?:emptyList(),now,context.getOrNull()?.customers?.singleOrNull())}
        CartRowUi(line.productId,product,q?.quantityBase?:line.quantityBase,(q?.unitPriceMinor?:own?.unitPriceMinor)?.let{PosMoney.format(it,currency)+" each"},
            q?.let{PosMoney.format(it.totalMinor,currency)}?:"Office price",
            q?.promotion?.let{"${it.name}${if(q.discountMinor>0)" · discount ${PosMoney.format(q.discountMinor,currency)}" else ""}"},
            context.getOrNull()?.stock?.firstOrNull{it.productId==line.productId}?.availableBase?:0L)
    }
    val browseTotal=when{cart.isEmpty()->"₱0.00";quote!=null->PosMoney.format(quote.totalMinor,currency);else->"Not ready"}
    val shiftOpen=c.storePos.shift!=null
    val reason=when{
        context.isFailure->context.exceptionOrNull()?.message
        !shiftOpen->"Open a session before selling."
        claim!=null&&!com.sunpride.van.selling.PrivilegeSwitch.offered(c.policy)->com.sunpride.van.selling.PrivilegeSwitch.OFF_MESSAGE
        (evaluation.exceptionOrNull() as? CheckoutRefused)?.issues?.any{it.problem==CheckoutProblem.PROMOTION_NEEDS_OFFICE}==true->"This campaign needs office finance authority before selling"
        claim!=null&&(evaluation.exceptionOrNull() as? CheckoutRefused)?.issues?.firstOrNull{it.problem in setOf(CheckoutProblem.DISCOUNT_TAX_UNKNOWN,CheckoutProblem.DISCOUNT_CLAIM_INVALID,CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL)}!=null->
            (evaluation.exceptionOrNull() as CheckoutRefused).issues.first{it.problem in setOf(CheckoutProblem.DISCOUNT_TAX_UNKNOWN,CheckoutProblem.DISCOUNT_CLAIM_INVALID,CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL)}.let{VanRules.checkoutMessage(it.problem,it.productId?.let{id->products.firstOrNull{p->p.productId==id}?.name})}
        else->setupProblem
    }
    if(claiming)ClaimSheet(items=cart.map{l->l.productId to (products.firstOrNull{it.productId==l.productId}?.name?:"Item")},initial=claim,
        onApply={claim=it;employee=false;pin="";points="";claiming=false},onRemove=if(claim!=null)({claim=null;claiming=false}) else null,onClose={claiming=false},
        capLeft={cl->context.getOrNull()?.capRemaining?.invoke(cl)})
    when(flow.step){
        SellStep.BROWSE,SellStep.CART->SellingBrowse(
            title="Store sale",subtitle=config.storeName?:"Store",onBack=null,place=SellingPlace.STORE,
            search=index,scanProducts=products,currentLines={cart},
            onSetLine={id,base->if(!c.busy){c.dismissGenericMessage();cart=SellingCart.set(cart,id,base)}},
            rows=rows,totalLabel=browseTotal,chargeEnabled=quote!=null&&shiftOpen&&!c.busy&&!c.onHold,onCharge={send(SellEvent.ChargeTapped)},
            cartOpen=flow.step==SellStep.CART,onCartOpen={open->send(if(open)SellEvent.CartBarTapped else SellEvent.BackTapped)},
            message=c.message?:notice?:reason,busy=c.busy,cashierName=c.seller?.name,roleLabel="Cashier",syncBadge={SyncPill(c)},
            held=storeHeld)
        SellStep.PAYMENT->{
            val switchedOn=com.sunpride.van.selling.PrivilegeSwitch.offered(c.policy)
            val possible=StoreCheckout.claimsPossible(config)&&(switchedOn||claim!=null)
            val canDiscount=possible&&!c.busy&&cart.isNotEmpty()
            val hasSupervisor=config.details.optJSONObject("supervisor")!=null
            val customerDetail=when{phone.isNotBlank()->phone;employee->"Employee";else->null}
            PaymentStep(
            title="Payment",totalMinor=total,subtitle=config.storeName,
            choices=listOf(TenderChoice("cash","Cash",TenderKind.CASH),TenderChoice("gcash","GCash",TenderKind.OTHER),TenderChoice("card","Card",TenderKind.OTHER),TenderChoice("split","Split",TenderKind.OTHER))
                .filter{when(it.id){"split"->"cash" in enabledTenders&&"gcash" in enabledTenders;else->it.id in enabledTenders||it.id=="cash"}},
            selectedId=tender,onSelect={tender=it;tenderedMinor=null;exact=false},tenderedMinor=tenderedNow,onTendered={exact=false;tenderedMinor=it},
            issues=buildList{
                if(quote!=null&&total==null)add("Points or discounts do not match this basket.")
                if(employee&&pin.length<6)add("Enter the supervisor PIN for the employee discount.")
                if(!shiftOpen)add("Open a session before selling.")
                setupProblem?.let{add(it)}
            },
            saving=flow.saving,canPay=canPay,exactEnabled=setupProblem==null&&total!=null&&tender=="cash"&&shiftOpen&&!c.busy&&!c.onHold&&(!employee||pin.length>=6)&&buildTenders(total,total)!=null,
            exactActive=exact&&tender=="cash",
            // EXACT only fills Tendered = Total (change ₱0.00). The cashier still adds a discount or a customer, then presses Complete.
            onExact={if(total!=null){send(SellEvent.ExactTapped);exact=true;tenderedMinor=null}},
            onPay={val n=total;val t=tenders;if(n!=null&&t!=null)pay(t,n)},onBack={send(SellEvent.BackTapped)},message=c.message?:notice,
            options=listOf(
                PayOption("Discount",claim?.type?.label,"store-claim",{claiming=true},enabled=canDiscount,active=claim!=null),
                PayOption("Customer",customerDetail,"store-more",{more=true},enabled=!c.busy,active=customerDetail!=null)
            )){
            claim?.let{cl->ClaimSummary(cl,quote?.legal,VanController.ClaimPreview.None,{claiming=true})}
            if(!switchedOn&&claim==null)Text(com.sunpride.van.selling.PrivilegeSwitch.OFF_MESSAGE,style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("store-claim-off"))
            else if(!possible)Text("Discounts are not available yet: this store's tax set-up has not reached the phone. Sync, or ask the office.",style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("store-claim-unavailable"))
            if(tender=="split"){
                SectionCard("Split tender"){
                    LabeledField("Cash part (₱)",cashShare,{cashShare=it},"store-split-cash",numeric=true,maxLength=16)
                    LabeledField("Card part (₱, optional)",cardShare,{cardShare=it},"store-split-card",numeric=true,maxLength=16)
                    Text("The remainder is paid by e-wallet. All parts must add up to the total.")
                    LabeledField("Cash received (₱, blank means exact)",received,{received=it},"store-cash-tendered",numeric=true,maxLength=16)
                }
            }
            if(tender in setOf("gcash","split"))LabeledField("E-wallet confirmation reference",walletRef,{walletRef=it},"store-wallet-ref",maxLength=100)
            if(tender in setOf("card","split"))LabeledField("Card approval reference — never card number",cardRef,{cardRef=it},"store-card-ref",maxLength=100)
            if(tender!="cash")Text("E-wallet and card references await office confirmation; they are not bank settlement proof.",style=MaterialTheme.typography.bodyMedium)
            if(more)StoreCustomerSheet(phone,{phone=it},notice,loyaltyOn=claim==null&&config.details.optJSONObject("loyalty")?.optBoolean("enabled")==true,
                onLookup={scope.launch {notice=runCatching {c.repository.storeLookup(phone)?.let {"${it.getString("name")} · ${it.getString("points")} points"}?:"No customer found. Add them in Customers."}.getOrElse {"Connect to look up this customer."}}},
                found=config.details.optJSONObject("customerLookup")?.takeIf {it.optString("phone")==runCatching{StoreCheckout.normalizePhone(phone)}.getOrNull()}?.let {"${it.getString("name")} · ${StoreCheckout.availablePoints(config,c.storePos.rows)} points available"},
                points=points,onPoints={points=it},employeeOn=claim==null&&hasSupervisor,employee=employee,onToggleEmployee={employee=!employee;pin=""},pin=pin,onPin={pin=it},
                claimNote=claim!=null,onClose={more=false})
            Text("Saved on this register before upload. Printing does not need a network.",style=MaterialTheme.typography.bodyMedium)
        }}
        SellStep.COMPLETE->{
            val done=completed
            val receipts=StoreTransactions.receipts(config,c.storePos.rows)
            val receiptNumber=done?.let{d->receipts.firstOrNull{it.optString("saleId")==d.saleId}?.optString("receiptNumber")}
            CompleteStep(title="Sale saved",receivedLabel=Peso.format(done?.receivedMinor?:0),totalLabel=Peso.format(done?.totalMinor?:0),changeLabel=Peso.format(done?.changeMinor?:0),
                headline=receiptNumber?:"Saved on this register",onNewSale=::newSale,secondaryLabel="Receipts",onSecondary={c.open(Page.STORE_RECEIPTS)},message=c.message?:c.printMessage){
                done?.let{d->
                    val history=c.storePrints[d.saleId].orEmpty()
                    val confirmed=history.any{it.confirmed}
                    SectionCard("Receipt"){
                        Text(when{ReprintRules.needsConfirmation(history)->"Sent to printer · did it print?";confirmed->"Printed";history.any{it.outcome==PrintOutcome.SKIPPED}->"Not printed · skipped, no paper";c.printing->"Printing…";else->"Not printed yet"},
                            style=MaterialTheme.typography.bodyLarge,modifier=Modifier.testTag("print-status"))
                        when{
                            ReprintRules.needsConfirmation(history)->SecondaryButton("Did it print?",{c.askDidItPrint(d.saleId,true)},Modifier.testTag("store-did-it-print"),enabled=!c.printing)
                            !confirmed->SecondaryButton(if(c.printing)"Printing…" else "Print receipt",{c.printStoreReceipt(d.saleId)},Modifier.testTag("store-print"),enabled=!c.printing)
                            else->{}
                        }
                    }
                }
                Text("Saved on this register first. It is sent to the office at the next sync.",style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("sale-saved-note-2"))
            }
        }
    }
}

/** Customer phone, points and the employee discount, as a bottom sheet over Payment (it used to be a long inline block under the Complete button). */
@Composable internal fun StoreCustomerSheet(phone:String,onPhone:(String)->Unit,notice:String?,loyaltyOn:Boolean,onLookup:()->Unit,found:String?,points:String,onPoints:(String)->Unit,
    employeeOn:Boolean,employee:Boolean,onToggleEmployee:()->Unit,pin:String,onPin:(String)->Unit,claimNote:Boolean,onClose:()->Unit){
    LookSheet("Customer & points",onClose,tag="store-customer-sheet",closeTag="store-customer-close",footer={
        PillButton("Done",onClose,Modifier.testTag("store-customer-done"),height=56.dp,fontSize=20.sp)
    }){
        Column(Modifier.padding(horizontal=20.dp,vertical=12.dp),verticalArrangement=Arrangement.spacedBy(10.dp)){
            LabeledField("Customer phone (optional)",phone,onPhone,"store-sale-phone",numeric=true,maxLength=24)
            notice?.let{Text(it,style=MaterialTheme.typography.bodyLarge,fontWeight=FontWeight.SemiBold,modifier=Modifier.testTag("store-customer-notice"))}
            if(loyaltyOn){
                SecondaryButton("Look up customer & points",onLookup)
                found?.let{Text(it)}
                LabeledField("Points to redeem",points,onPoints,"store-points",numeric=true,maxLength=9)
            }
            if(employeeOn){
                SecondaryButton(if(employee)"Remove employee discount" else "Employee discount",onToggleEmployee)
                if(employee)LabeledField("Supervisor PIN",pin,onPin,"store-supervisor-pin",password=true,maxLength=12)
            }
            if(claimNote)Text("A Senior, PWD or other discount replaces points and the employee discount on this sale.",style=MaterialTheme.typography.bodyMedium)
            if(!loyaltyOn&&!employeeOn&&!claimNote)Text("Loyalty and employee discounts are not turned on for this store. The phone number is saved with the receipt.",style=MaterialTheme.typography.bodyMedium)
        }
    }
}

/** F-R03 frozen receipt preview, print with "Did it print?", and independently approved reversal requests. */
@Composable fun StoreReceiptsScreen(c:VanController){
    val config=c.storePos.config?:return
    var reason by remember{mutableStateOf("")}
    var reprinting by remember{mutableStateOf<JSONObject?>(null)}
    val receipts=StoreTransactions.receipts(config,c.storePos.rows)
    ScreenFrame("Sales",message=c.message?:c.printMessage,trailing={SyncPill(c)}){
        if(receipts.isEmpty())EmptyState(GlyphKind.RECEIPT,"No receipts yet","Sales you complete here show up as receipts. You can print or reprint them, or ask for a void or refund.",Modifier.testTag("store-no-receipts"),
            actionLabel="Go to Sell",onAction={c.open(Page.STORE_SALE)},actionTag="sales-go-sell")
        else{
            LabeledField("Void / refund reason",reason,{reason=it},"store-reversal-reason",maxLength=300)
            Text("A second person approves voids and receipt-linked refunds in the office. Voids are only for the original open session; refunds return stock into quality hold.",style=MaterialTheme.typography.bodyMedium)
        }
        receipts.forEach {r->SectionCard(r.getString("receiptNumber")){
            Text(r.optString("customer","Walk-in"));Text(pesos(r.getString("totalMinor").toLong()),style=MaterialTheme.typography.titleLarge)
            StoreCheckout.objects(r.getJSONArray("lines")).forEach {Text("${it.getString("description")} · ${it.get("quantity")} ${it.getString("uom")}")}
            StoreCheckout.objects(r.getJSONArray("tenders")).forEach {Text("${it.optString("label",it.getString("method"))} · ${pesos(it.getString("amountCentavos").toLong())}")}
            if(r.optJSONObject("fiscal")?.optBoolean("sample")==true)Text("Sample series · not a filed BIR PTU")
            val id=r.getString("saleId");val history=c.storePrints[id].orEmpty()
            val confirmed=history.any {it.confirmed}
            Text(when{ReprintRules.needsConfirmation(history)->"Sent to printer · did it print?";confirmed->"Printed · ${ReprintRules.remaining(history)} reprints left";history.any {it.outcome==PrintOutcome.SKIPPED}->"Not printed · skipped, no paper";else->"Not printed"},
                Modifier.testTag("store-print-state-$id"))
            when{
                ReprintRules.needsConfirmation(history)->SecondaryButton("Did it print?",{c.askDidItPrint(id,true)},Modifier.testTag("store-did-it-print"),enabled=!c.printing)
                !confirmed->SecondaryButton(if(c.printing)"Printing…" else "Print receipt",{c.printStoreReceipt(id)},Modifier.testTag("store-print"),enabled=!c.printing)
                ReprintRules.remaining(history)>0->SecondaryButton(if(c.printing)"Printing…" else "Reprint",{reprinting=r},Modifier.testTag("store-reprint"),enabled=!c.printing)
                else->Text("Reprinted ${ReprintRules.MAX_REPRINTS} times. Ask the office for a copy.")
            }
            // A saved credit memo can always be printed again (the slip may not have come out the first time).
            com.sunpride.van.storepos.StoreRefunds.local(c.storePos.rows).filter {it.getString("saleId")==id}.forEach {m->
                val rid=m.getString("refundId");val cm=m.optString("creditNumber")
                Text("Credit memo $cm · ${pesos(m.getString("expectedCentavos").toLong())} refunded",Modifier.testTag("store-credit-memo-$rid"))
                SecondaryButton(if(c.printing)"Printing…" else "Print credit memo",{c.printStoreRefundSlip(rid)},Modifier.testTag("store-print-credit-memo-$rid"),enabled=!c.printing)
            }
            com.sunpride.van.storepos.StoreRefunds.refused(c.storePos.rows).filter {it.first.getString("saleId")==id}.forEach {(m,why)->
                val rid=m.getString("refundId")
                Text("Credit memo ${m.optString("creditNumber")} · ${pesos(m.getString("expectedCentavos").toLong())} · refused by the office",fontWeight=FontWeight.SemiBold,modifier=Modifier.testTag("store-credit-memo-refused-$rid"))
                Text(why,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodyMedium)
            }
            if(r.optString("_status")!="voided"){
                // IP-REFUND: take back some of the items now, paid out of the open drawer (a supervisor approves above the office's amount).
                if(com.sunpride.van.storepos.StoreRefunds.policy(config)!=null)SecondaryButton("Refund items",{c.openStoreRefund(r)},Modifier.testTag("store-refund-items-${r.getString("saleId")}"),enabled=c.storePos.shift!=null&&!c.busy)
                DangerButton("Request void before close",{c.saveStoreAction("store.void",JSONObject().put("saleId",r.getString("saleId")).put("reason",reason))},enabled=reason.isNotBlank()&&c.storePos.shift!=null&&!c.busy)
                DangerButton("Request receipt refund",{c.saveStoreAction("store.refund",JSONObject().put("saleId",r.getString("saleId")).put("reason",reason))},enabled=reason.isNotBlank()&&c.storePos.shift!=null&&!c.busy)
            }else Text("Voided · retained in the immutable journal")
        }}
    }
    c.storeRefundModel?.let {m->RefundSheet(m,RefundApprovalKind.PIN,Supervisors.of(config.details,c.seller?.profileId),c.busy,c.storeRefundError,onConfirm={c.confirmStoreRefund(it)},onClose=c::cancelStoreRefund)}
    c.storeRefundDone?.let {d->RefundDoneDialog(d.creditNumber,d.originalNumber,d.totalMinor,d.tenders.filter{it.method=="cash"}.sumOf{it.amountMinor},d.damaged,c.printMessage,c.printing,onPrint={c.printStoreRefundSlip(null)},onDone=c::finishStoreRefund)}
    reprinting?.let {r->
        val history=c.storePrints[r.getString("saleId")].orEmpty()
        ReprintReasonDialog("${r.getString("receiptNumber")} · ${pesos(r.getString("totalMinor").toLong())}",ReprintRules.MAX_REPRINTS-ReprintRules.remaining(history)+1,
            onPrint={why->c.printStoreReceipt(r.getString("saleId"),why);reprinting=null},onClose={reprinting=null})
    }
}

/**
 * F-R04 physical receiving and blind full/cycle capture feed canonical inventory commands.
 * POS v2 (beta.31): three places under a short title (Receive, Count, Transfers), one sticky action per place, the explanation
 * collapsed behind "How this works", and a product picker instead of a button per product. The saved commands are unchanged.
 */
@Composable fun StoreStockScreen(c:VanController){
    val config=c.storePos.config?:return
    val catalogue=StoreCheckout.objects(config.details.optJSONArray("catalogue"))
    val transfers=StoreCheckout.objects(config.details.optJSONArray("transfers"))
    var mode by remember{mutableStateOf(if(transfers.isNotEmpty())"transfers" else "receive")}
    var kind by remember{mutableStateOf("full")}
    var po by remember{mutableStateOf("")}
    var product by remember{mutableStateOf(catalogue.firstOrNull()?.getString("productId")?:"")}
    var amount by remember{mutableStateOf("")}
    var lot by remember{mutableStateOf("")}
    var expiry by remember{mutableStateOf("")}
    var counts by remember{mutableStateOf(emptyMap<String,String>())}
    val open=c.storePos.shift!=null&&!c.busy
    val selected=if(kind=="cycle")catalogue.filter {it.getString("productId")==product}else catalogue
    val entries=if(mode=="count")selected.flatMap {p->StoreCheckout.objects(p.getJSONArray("stockLines")).map {l->p to l}} else emptyList()
    fun key(p:JSONObject,l:JSONObject)="${p.getString("productId")}:${l.optString("lotId")}:${l.getString("stockStatus")}"
    val receiveProblem=com.sunpride.van.storepos.StoreStockRules.receiveProblem(po,product,amount,expiry,open)
    val receiveOk=receiveProblem==null
    // POS-042: the button stays tappable and says what is wrong next to it (the field's own line can be off screen).
    var receiveTapped by remember{mutableStateOf(false)}
    val countOk=entries.isNotEmpty()&&entries.all {(p,l)->quantity(counts[key(p,l)]?:"",p.getString("quantityScale").toLong())!=null}&&open
    val saveReceive={c.saveStoreAction("store.receive",JSONObject().put("purchaseOrder",po).put("lines",JSONArray().put(JSONObject().put("productId",product).put("quantityBase",checkNotNull(com.sunpride.van.storepos.StoreStockRules.quantity(amount))).put("lotNumber",lot).apply{if(expiry.isNotBlank())put("expiresAt",java.time.LocalDate.parse(expiry.trim()).atStartOfDay(java.time.ZoneId.of("Asia/Manila")).toInstant().toEpochMilli())})))}
    val submitCount={c.saveStoreAction("store.count",JSONObject().put("countType",kind).put("lines",JSONArray(entries.map {(p,l)->com.sunpride.van.storepos.StoreStockRules.countLine(p,l,checkNotNull(quantity(counts[key(p,l)]?:"",p.getString("quantityScale").toLong())))})))}
    ScreenFrame("Stock",message=c.message,trailing={SyncPill(c)},
        action=when(mode){"receive"->"Save receiving";"count"->"Submit count";else->null},actionTag="store-stock-save",
        footer=if(mode=="receive"&&receiveTapped)receiveProblem else null,
        onAction={if(mode=="receive"){receiveTapped=true;if(receiveOk)saveReceive()} else submitCount()},enabled=if(mode=="receive")c.storePos.shift!=null&&!c.busy else countOk){
        SegmentedChips(listOf("receive" to "Receive","count" to "Count","transfers" to (if(transfers.isEmpty())"Transfers" else "Transfers (${transfers.size})")),mode,{mode=it},"store-stock-mode")
        if(c.storePos.shift==null)Text("Open the till (Till tab) to save stock changes.",style=MaterialTheme.typography.bodyLarge,color=Look.muted,modifier=Modifier.testTag("store-stock-needs-till"))
        when(mode){
            "receive"->{
                HelpDisclosure("How receiving works","Receive against a purchase order reference. Lot and expiry checks follow the inventory policy, and stock may enter quality hold. Type the expiry date as YYYY-MM-DD.","store-stock-help")
                LabeledField("Purchase order reference",po,{po=it},"store-po-reference",maxLength=100)
                StockProductPicker(catalogue,product,{product=it},"store-product")
                LabeledField("Quantity received (base units)",amount,{amount=it},"store-receive-quantity",numeric=true,maxLength=12)
                if(amount.isNotBlank()&&com.sunpride.van.storepos.StoreStockRules.quantity(amount)==null)Text(com.sunpride.van.storepos.StoreStockRules.QUANTITY_PROBLEM,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("store-receive-quantity-problem"))
                Row(Modifier.fillMaxWidth(),horizontalArrangement=Arrangement.spacedBy(8.dp)){
                    Box(Modifier.weight(1f)){LabeledField("Lot, if required",lot,{lot=it},"store-receive-lot",maxLength=100)}
                    Box(Modifier.weight(1f)){LabeledField("Expiry date",expiry,{expiry=it},"store-receive-expiry",maxLength=10)}
                }
                if(!com.sunpride.van.storepos.StoreStockRules.expiryOk(expiry))Text(com.sunpride.van.storepos.StoreStockRules.EXPIRY_PROBLEM,color=MaterialTheme.colorScheme.error,style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("store-receive-expiry-problem"))
            }
            "count"->{
                HelpDisclosure("How counting works","Count what is on the shelf. Expected quantities are hidden. The office must independently approve any variance before posting.","store-stock-help")
                SegmentedChips(listOf("full" to "All products","cycle" to "One product"),kind,{kind=it},"store-count-kind")
                if(kind=="cycle")StockProductPicker(catalogue,product,{product=it},"store-count-product")
                entries.forEach {(p,l)->val k=key(p,l)
                    LabeledField(com.sunpride.van.storepos.StoreStockRules.lineLabel(p,l),counts[k]?:"",{counts=counts+(k to it)},"store-count-${p.getString("code")}",numeric=true,maxLength=12)
                }
                if(entries.isEmpty())EmptyState(GlyphKind.BOX,"Nothing to count","There is no stock on this phone for that choice. Sync to refresh the list.")
                Spacer(Modifier.height(8.dp))
            }
            else->{
                HelpDisclosure("How transfers work","Receive marks every line as received in full, as shipped.","store-stock-help")
                transfers.forEach {t->SectionCard(t.getString("name")){
                    StoreCheckout.objects(t.getJSONArray("lines")).forEach {Text("${it.getString("name")} · ${it.getString("quantityBase")} base units",style=MaterialTheme.typography.bodyLarge)}
                    PillButton("Receive all shipped",{c.saveStoreAction("store.receive",JSONObject().put("transferId",t.getString("id")).put("lines",com.sunpride.van.storepos.StoreStockRules.receiveAllShipped(t.getJSONArray("lines"))))},Modifier.testTag("store-transfer-receive"),enabled=open,height=52.dp,fontSize=17.sp)
                }}
                if(transfers.isEmpty())EmptyState(GlyphKind.TRUCK,"No transfers on the way","Shipments sent to this store show up here, ready to receive.")
            }
        }
    }
}

/** A one-line "How this works" row that opens its text in place. Collapsed by default so the form is the first thing on screen. */
@Composable fun HelpDisclosure(title:String,text:String,tag:String){
    var open by rememberSaveable{mutableStateOf(false)}
    val shape=androidx.compose.foundation.shape.RoundedCornerShape(18.dp)
    Column(Modifier.fillMaxWidth().clip(shape).background(Look.card).border(1.dp,Look.hairline,shape).testTag(tag)){
        Row(Modifier.fillMaxWidth().heightIn(min=48.dp).clickable(onClickLabel=if(open)"Hide help" else "Show help"){open=!open}.padding(horizontal=16.dp).testTag("$tag-toggle"),verticalAlignment=Alignment.CenterVertically){
            Text(title,Modifier.weight(1f),style=MaterialTheme.typography.bodyLarge,fontWeight=FontWeight.SemiBold)
            Glyph(GlyphKind.CHEVRON,Look.muted,20.dp,Modifier.rotate(if(open)90f else 0f))
        }
        if(open)Text(text,Modifier.padding(start=16.dp,end=16.dp,bottom=14.dp).testTag("$tag-text"),style=MaterialTheme.typography.bodyMedium)
    }
}

/** The chosen product as a pill; tapping it opens a list, so the form is not pushed down by one button per product. */
@Composable fun StockProductPicker(products:List<JSONObject>,selected:String,onSelect:(String)->Unit,tag:String){
    var open by remember{mutableStateOf(false)}
    val current=products.firstOrNull {it.getString("productId")==selected}?.getString("name")
    val shape=androidx.compose.foundation.shape.RoundedCornerShape(Look.pill)
    Row(Modifier.fillMaxWidth().heightIn(min=56.dp).clip(shape).border(1.5.dp,Look.hairline,shape).clickable(onClickLabel="Choose a product"){open=true}.padding(start=16.dp,end=12.dp,top=6.dp,bottom=6.dp).testTag(tag),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(8.dp)){
        Column(Modifier.weight(1f)){
            Text("Product",color=Look.muted,fontSize=13.sp,fontWeight=FontWeight.SemiBold,maxLines=1)
            FitText(current?:"Choose a product",16.sp,minSize=13.sp,fontWeight=FontWeight.SemiBold,color=Look.ink)
        }
        Glyph(GlyphKind.CHEVRON,Look.muted,20.dp)
    }
    if(open)LookSheet("Choose a product",{open=false},tag="$tag-sheet",closeTag="$tag-close",footer={PillButton("Cancel",{open=false},Modifier.testTag("$tag-cancel"),filled=false,height=52.dp)}){
        Column(Modifier.padding(horizontal=20.dp).padding(top=14.dp,bottom=20.dp),verticalArrangement=Arrangement.spacedBy(8.dp)){
            products.forEach {p->
                val id=p.getString("productId");val on=id==selected
                val row=androidx.compose.foundation.shape.RoundedCornerShape(18.dp)
                Row(Modifier.fillMaxWidth().heightIn(min=56.dp).clip(row).background(if(on)Look.tint else Look.card).border(if(on)2.dp else 1.dp,if(on)Look.accent else Look.hairline,row).clickable{onSelect(id);open=false}.padding(horizontal=16.dp,vertical=8.dp).testTag("$tag-$id"),verticalAlignment=Alignment.CenterVertically,horizontalArrangement=Arrangement.spacedBy(10.dp)){
                    Text(p.getString("name"),Modifier.weight(1f),fontSize=17.sp,fontWeight=FontWeight.SemiBold)
                    if(on)Glyph(GlyphKind.CHECK,Look.accent,22.dp)
                }
            }
        }
    }
}

/** F-R06 evidence uses the existing bounded encrypted photo store and signed upload path. */
@Composable fun StoreDepositScreen(c:VanController){
    val config=c.storePos.config?:return
    val scope=rememberCoroutineScope()
    var camera by remember{mutableStateOf(false)}
    var photo by remember{mutableStateOf<String?>(null)}
    var notice by remember{mutableStateOf<String?>(null)}
    var bank by remember{mutableStateOf("")};var reference by remember{mutableStateOf("")};var amount by remember{mutableStateOf("")}
    val reads=StoreCheckout.objects(config.details.optJSONArray("reads")).filter {it.getString("kind")=="z"}
    var readId by remember(reads.map{it.getString("id")}){mutableStateOf(reads.firstOrNull()?.getString("id")?:"")}
    if(camera){DamageCameraScreen(onCaptured={capture->camera=false;scope.launch{runCatching{c.repository.saveDepositPhoto(capture)}.onSuccess{photo=it;notice="Deposit-slip photo saved securely"}.onFailure{notice="Could not save the photo. Try again."}}},onClose={camera=false},requireLocation=false,title="Deposit slip",instructions="Show the bank, amount and slip reference clearly.");return}
    ScreenFrame("Cash deposit",c::back,action="Save deposit",actionTag="save-store-deposit",onAction={c.saveStoreAction("store.deposit",JSONObject().put("zReadId",readId).put("bank",bank).put("reference",reference).put("amountCentavos",checkNotNull(VanRules.parseMoney(amount)).toString()).put("photoSha256",photo))},enabled=readId.isNotBlank()&&bank.isNotBlank()&&reference.isNotBlank()&&photo!=null&&(VanRules.parseMoney(amount)?:0)>0&&!c.busy,message=c.message?:notice){
        Text("Match the deposit to one Z-read. Opening float is excluded; a discrepancy goes to independent office review.")
        reads.forEach {r->SecondaryButton((if(readId==r.getString("id"))"Selected · " else "")+"Z read ${r.getString("sequence")}",{readId=r.getString("id")})}
        if(reads.isEmpty())Text("Sync the Z-read first to receive its office reference.")
        LabeledField("Bank",bank,{bank=it},"store-deposit-bank",maxLength=100)
        LabeledField("Deposit slip reference",reference,{reference=it},"store-deposit-reference",maxLength=100)
        LabeledField("Amount deposited (₱)",amount,{amount=it},"store-deposit-amount",numeric=true,maxLength=16)
        SecondaryButton(if(photo==null)"Take deposit-slip photo" else "Replace deposit-slip photo",{camera=true},enabled=!c.busy)
        Text("The photo and deposit remain on this phone until the signed upload is acknowledged.")
    }
}

/** F-R07 exact phone lookup; loyalty is configured off by default and never assumed enabled. */
@Composable fun StoreCustomersScreen(c:VanController){
    var phone by remember{mutableStateOf("")};var name by remember{mutableStateOf("")};var notice by remember{mutableStateOf<String?>(null)}
    val scope=rememberCoroutineScope()
    ScreenFrame("Customers & points",c::back,message=notice?:c.message){
        Text(if(c.storePos.config?.details?.optJSONObject("loyalty")?.optBoolean("enabled")==true)"Points are on." else "Points are off.",style=MaterialTheme.typography.bodyMedium)
        LabeledField("Customer phone",phone,{phone=it},"store-customer-phone",numeric=true,maxLength=24)
        SecondaryButton("Look up phone",{scope.launch {notice=runCatching {c.repository.storeLookup(phone)?.let {"${it.getString("name")} · ${it.getString("points")} points"}?:"No customer found"}.getOrElse {"Connect to look up this phone."}}},enabled=phone.length>=7&&!c.busy)
        LabeledField("Customer name",name,{name=it},"store-customer-name",maxLength=100)
        PrimaryBottomButton("Add customer",{c.saveStoreAction("store.customer",JSONObject().put("phone",phone).put("name",name))},phone.length>=7&&name.isNotBlank()&&c.storePos.shift!=null&&!c.busy,"store-add-customer")
        if(c.storePos.shift==null)Text("Open the till to add customers.",style=MaterialTheme.typography.bodyMedium)
    }
}
