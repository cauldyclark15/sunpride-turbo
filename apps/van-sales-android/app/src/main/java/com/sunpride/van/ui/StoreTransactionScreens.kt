package com.sunpride.van.ui

import androidx.compose.material3.*
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
    var saleId by remember(config.modeVersionId){mutableStateOf(UUID.randomUUID().toString())}
    var flow by remember{mutableStateOf(SellFlow())}
    fun send(e:SellEvent){flow=SellFlowReducer.reduce(flow,e)}
    var tender by remember {mutableStateOf("cash")}
    var tenderedMinor by remember {mutableStateOf<Long?>(null)}
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
    val tenders=total?.let{n->buildTenders(n,if(tender=="split")splitCashTendered else tenderedMinor)}
    val cashReady=when(tender){"cash"->tenderedMinor!=null&&total!=null&&tenderedMinor!!>=total;else->true}
    val canPay=total!=null&&tenders!=null&&cashReady&&c.storePos.shift!=null&&!c.busy&&!c.onHold&&(!employee||pin.length>=6)
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

    fun newSale(){
        cart=emptyList();saleId=UUID.randomUUID().toString();tender="cash";tenderedMinor=null;cashShare="";cardShare="";received="";walletRef="";cardRef="";phone="";points="";employee=false;pin="";more=false;claim=null;claiming=false;notice=null;completed=null;savedFlag=false
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
        (evaluation.exceptionOrNull() as? CheckoutRefused)?.issues?.any{it.problem==CheckoutProblem.PROMOTION_NEEDS_OFFICE}==true->"This campaign needs office finance authority before selling"
        claim!=null&&(evaluation.exceptionOrNull() as? CheckoutRefused)?.issues?.firstOrNull{it.problem in setOf(CheckoutProblem.DISCOUNT_TAX_UNKNOWN,CheckoutProblem.DISCOUNT_CLAIM_INVALID,CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL)}!=null->
            (evaluation.exceptionOrNull() as CheckoutRefused).issues.first{it.problem in setOf(CheckoutProblem.DISCOUNT_TAX_UNKNOWN,CheckoutProblem.DISCOUNT_CLAIM_INVALID,CheckoutProblem.DISCOUNT_CLAIM_WITH_MANUAL)}.let{VanRules.checkoutMessage(it.problem,it.productId?.let{id->products.firstOrNull{p->p.productId==id}?.name})}
        else->null
    }
    if(claiming)ClaimSheet(items=cart.map{l->l.productId to (products.firstOrNull{it.productId==l.productId}?.name?:"Item")},initial=claim,
        onApply={claim=it;employee=false;pin="";points="";claiming=false},onRemove=if(claim!=null)({claim=null;claiming=false}) else null,onClose={claiming=false})
    when(flow.step){
        SellStep.BROWSE,SellStep.CART->SellingBrowse(
            title="Store sale",subtitle=config.storeName?:"Store",onBack=c::back,place=SellingPlace.STORE,
            search=index,scanProducts=products,currentLines={cart},
            onSetLine={id,base->if(!c.busy)cart=SellingCart.set(cart,id,base)},
            rows=rows,totalLabel=browseTotal,chargeEnabled=quote!=null&&shiftOpen&&!c.busy&&!c.onHold,onCharge={send(SellEvent.ChargeTapped)},
            cartOpen=flow.step==SellStep.CART,onCartOpen={open->send(if(open)SellEvent.CartBarTapped else SellEvent.BackTapped)},
            message=c.message?:notice?:reason,busy=c.busy,cashierName=c.seller?.name,roleLabel="Cashier")
        SellStep.PAYMENT->PaymentStep(
            title="Payment",totalMinor=total,
            choices=listOf(TenderChoice("cash","Cash",TenderKind.CASH),TenderChoice("gcash","GCash / e-wallet",TenderKind.OTHER),TenderChoice("card","Card",TenderKind.OTHER),TenderChoice("split","Split",TenderKind.OTHER)),
            selectedId=tender,onSelect={tender=it;tenderedMinor=null},tenderedMinor=tenderedMinor,onTendered={tenderedMinor=it},
            issues=buildList{
                if(quote!=null&&total==null)add("Points or discounts do not match this basket.")
                if(employee&&pin.length<6)add("Enter the supervisor PIN for the employee discount.")
                if(!shiftOpen)add("Open a session before selling.")
            },
            saving=flow.saving,canPay=canPay,exactEnabled=total!=null&&tender=="cash"&&shiftOpen&&!c.busy&&!c.onHold&&(!employee||pin.length>=6)&&buildTenders(total,total)!=null,
            onExact={val n=total;val t=n?.let{buildTenders(it,it)};if(n!=null&&t!=null)pay(t,n)},
            onPay={val n=total;val t=tenders;if(n!=null&&t!=null)pay(t,n)},onBack={send(SellEvent.BackTapped)},message=c.message?:notice){
            claim?.let{cl->ClaimSummary(cl,quote?.legal,VanController.ClaimPreview.None,{claiming=true})}
            if(claim==null){
                val possible=StoreCheckout.claimsPossible(config)
                SecondaryButton("Senior, PWD or other discount",{claiming=true},Modifier.testTag("store-claim"),enabled=possible&&!c.busy&&cart.isNotEmpty())
                if(!possible)Text("Not available yet: this store's tax set-up has not reached the phone, so the discount cannot be worked out. Sync, or ask the office.",style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("store-claim-unavailable"))
            }
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
            SecondaryButton(if(more)"Hide customer & discounts" else "Customer, points & employee discount",{more=!more},Modifier.testTag("store-more"))
            if(more){
                LabeledField("Customer phone (optional)",phone,{phone=it},"store-sale-phone",numeric=true,maxLength=24)
                if(claim==null&&config.details.optJSONObject("loyalty")?.optBoolean("enabled")==true){
                    SecondaryButton("Look up customer & points",{scope.launch {notice=runCatching {c.repository.storeLookup(phone)?.let {"${it.getString("name")} · ${it.getString("points")} points"}?:"No customer found. Register them in Customers."}.getOrElse {"Connect to look up this customer."}}})
                    config.details.optJSONObject("customerLookup")?.takeIf {it.optString("phone")==runCatching{StoreCheckout.normalizePhone(phone)}.getOrNull()}?.let {Text("${it.getString("name")} · ${StoreCheckout.availablePoints(config,c.storePos.rows)} points available")}
                    LabeledField("Points to redeem",points,{points=it},"store-points",numeric=true,maxLength=9)
                }
                if(claim==null&&config.details.optJSONObject("supervisor")!=null){
                    SecondaryButton(if(employee)"Remove employee discount" else "Employee discount",{employee=!employee;pin=""})
                    if(employee)LabeledField("Supervisor PIN",pin,{pin=it},"store-supervisor-pin",password=true,maxLength=12)
                }
            }
            Text("Saved before upload. Printing does not require a network. Any refused upload remains visible for review.",style=MaterialTheme.typography.bodyMedium)
        }
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

/** F-R03 frozen receipt preview, print with "Did it print?", and independently approved reversal requests. */
@Composable fun StoreReceiptsScreen(c:VanController){
    val config=c.storePos.config?:return
    var reason by remember{mutableStateOf("")}
    var reprinting by remember{mutableStateOf<JSONObject?>(null)}
    val receipts=StoreTransactions.receipts(config,c.storePos.rows)
    ScreenFrame("Store receipts",c::back,message=c.message?:c.printMessage){
        LabeledField("Void / refund reason",reason,{reason=it},"store-reversal-reason",maxLength=300)
        Text("A second person approves voids and receipt-linked refunds in the office. Voids are only for the original open session; refunds return stock into quality hold.")
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
            if(r.optString("_status")!="voided"){
                SecondaryButton("Request void before close",{c.saveStoreAction("store.void",JSONObject().put("saleId",r.getString("saleId")).put("reason",reason))},enabled=reason.isNotBlank()&&c.storePos.shift!=null&&!c.busy)
                SecondaryButton("Request receipt refund",{c.saveStoreAction("store.refund",JSONObject().put("saleId",r.getString("saleId")).put("reason",reason))},enabled=reason.isNotBlank()&&c.storePos.shift!=null&&!c.busy)
            }else Text("Voided · retained in the immutable journal")
        }}
        if(receipts.isEmpty())Text("No store receipts saved yet.")
    }
    reprinting?.let {r->
        val history=c.storePrints[r.getString("saleId")].orEmpty()
        ReprintReasonDialog("${r.getString("receiptNumber")} · ${pesos(r.getString("totalMinor").toLong())}",ReprintRules.MAX_REPRINTS-ReprintRules.remaining(history)+1,
            onPrint={why->c.printStoreReceipt(r.getString("saleId"),why);reprinting=null},onClose={reprinting=null})
    }
}

/** F-R04 physical receiving and blind full/cycle capture feed canonical inventory commands. */
@Composable fun StoreStockScreen(c:VanController){
    val config=c.storePos.config?:return
    val catalogue=StoreCheckout.objects(config.details.optJSONArray("catalogue"))
    val transfers=StoreCheckout.objects(config.details.optJSONArray("transfers"))
    var mode by remember{mutableStateOf("receive")}
    var po by remember{mutableStateOf("")}
    var product by remember{mutableStateOf(catalogue.firstOrNull()?.getString("productId")?:"")}
    var amount by remember{mutableStateOf("")}
    var lot by remember{mutableStateOf("")}
    var expiry by remember{mutableStateOf("")}
    var counts by remember{mutableStateOf(emptyMap<String,String>())}
    ScreenFrame("Receiving & counts",c::back,message=c.message){
        SecondaryButton("Receiving",{mode="receive"});SecondaryButton("Full count",{mode="full"});SecondaryButton("Cycle count",{mode="cycle"})
        if(mode=="receive"){
            transfers.forEach {t->SectionCard(t.getString("name")){
                StoreCheckout.objects(t.getJSONArray("lines")).forEach {Text("${it.getString("name")} · ${it.getString("quantityBase")} base units")}
                SecondaryButton("Receive the listed shipped quantities",{c.saveStoreAction("store.receive",JSONObject().put("transferId",t.getString("id")).put("lines",JSONArray(StoreCheckout.objects(t.getJSONArray("lines")).map {JSONObject().put("lineId",it.getString("lineId")).put("receivedBase",it.getString("quantityBase").toLong()).put("rejectedBase",0).put("shortBase",0)})))},enabled=c.storePos.shift!=null&&!c.busy)
            }}
            Text("Receive against a PO reference below. Lot and expiry checks use the existing inventory policy; stock may enter quality hold.")
            LabeledField("Purchase order reference",po,{po=it},"store-po-reference",maxLength=100)
            catalogue.forEach {p->SecondaryButton((if(product==p.getString("productId"))"Selected · " else "")+p.getString("name"),{product=p.getString("productId")})}
            LabeledField("Accepted base units",amount,{amount=it},"store-receive-quantity",numeric=true,maxLength=12)
            LabeledField("Batch / lot, if required",lot,{lot=it},"store-receive-lot",maxLength=100)
            LabeledField("Expiry YYYY-MM-DD, if required",expiry,{expiry=it},"store-receive-expiry",maxLength=10)
            SecondaryButton("Save PO receiving",{c.saveStoreAction("store.receive",JSONObject().put("purchaseOrder",po).put("lines",JSONArray().put(JSONObject().put("productId",product).put("quantityBase",amount.toLong()).put("lotNumber",lot).apply{if(expiry.isNotBlank())put("expiresAt",java.time.LocalDate.parse(expiry).atStartOfDay(java.time.ZoneId.of("Asia/Manila")).toInstant().toEpochMilli())})))},enabled=po.isNotBlank()&&product.isNotBlank()&&(amount.toLongOrNull()?:0)>0&&c.storePos.shift!=null&&!c.busy&&(expiry.isBlank()||runCatching{java.time.LocalDate.parse(expiry)}.isSuccess))
        }else{
            Text("Count physical stock. Expected quantities are hidden. The office must independently approve any variance before posting.")
            if(mode=="cycle")catalogue.forEach {p->SecondaryButton((if(product==p.getString("productId"))"Selected · " else "")+p.getString("name"),{product=p.getString("productId")})}
            val selected=if(mode=="cycle")catalogue.filter {it.getString("productId")==product}else catalogue
            val entries=selected.flatMap {p->StoreCheckout.objects(p.getJSONArray("stockLines")).map {l->p to l}}
            fun key(p:JSONObject,l:JSONObject)="${p.getString("productId")}:${l.optString("lotId")}:${l.getString("stockStatus")}"
            entries.forEach {(p,l)->val k=key(p,l)
                LabeledField("${p.getString("name")} · ${l.optString("lotNumber",l.getString("stockStatus"))} · ${p.getString("uomCode")}",counts[k]?:"",{counts=counts+(k to it)},"store-count-${p.getString("code")}",numeric=true,maxLength=12)
            }
            SecondaryButton("Submit blind ${mode} count",{
                c.saveStoreAction("store.count",JSONObject().put("countType",mode).put("lines",JSONArray(entries.map {(p,l)->JSONObject().put("productId",p.getString("productId")).put("lotId",l.opt("lotId")).put("stockStatus",l.getString("stockStatus")).put("version",l.getString("version")).put("countedBase",checkNotNull(quantity(counts[key(p,l)]?:"",p.getString("quantityScale").toLong())))})))
            },enabled=entries.isNotEmpty()&&entries.all {(p,l)->quantity(counts[key(p,l)]?:"",p.getString("quantityScale").toLong())!=null}&&c.storePos.shift!=null&&!c.busy)
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
        Text(if(c.storePos.config?.details?.optJSONObject("loyalty")?.optBoolean("enabled")==true)"Loyalty is enabled by the office." else "Loyalty is off. The office can configure earning and redemption.")
        LabeledField("Customer phone",phone,{phone=it},"store-customer-phone",numeric=true,maxLength=24)
        SecondaryButton("Look up phone",{scope.launch {notice=runCatching {c.repository.storeLookup(phone)?.let {"${it.getString("name")} · ${it.getString("points")} points"}?:"No customer found"}.getOrElse {"Connect to look up this phone. Previously verified lookup is retained securely."}}},enabled=phone.length>=7&&!c.busy)
        LabeledField("New customer name",name,{name=it},"store-customer-name",maxLength=100)
        SecondaryButton("Register customer",{c.saveStoreAction("store.customer",JSONObject().put("phone",phone).put("name",name))},enabled=phone.length>=7&&name.isNotBlank()&&c.storePos.shift!=null&&!c.busy)
    }
}
