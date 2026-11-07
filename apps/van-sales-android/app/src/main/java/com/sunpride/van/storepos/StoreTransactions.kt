package com.sunpride.van.storepos

import androidx.room.withTransaction
import com.sunpride.van.storage.*
import com.sunpride.van.pos.*
import com.sunpride.van.fiscal.FiscalNumbers
import com.sunpride.van.printing.*
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID
import java.math.BigInteger

/** F-R02..R07: existing encrypted outbox, shared quote engine and fiscal counter; no Room schema fork. */
class StoreTransactions(private val store:RoomVanStore) {
    private val dao=store.db.rows()
    private val s=store.scope.fullAuthSubject
    private val d=store.scope.deviceId
    private val sessions=StorePosStore(store)
    data class Tender(val method:String,val amount:Long,val reference:String?=null,val tendered:Long?=null)
    /** [supervise] (IP-HH2) signs the action once its session is known: it gets the shift id and returns the `supervisor` object for the payload. */
    suspend fun action(kind:String,payload:JSONObject,id:String=UUID.randomUUID().toString(),metadata:String?=null,supervise:((String)->JSONObject)?=null):String = store.db.withTransaction {
        require(kind in StorePosStore.KINDS)
        val config=sessions.writable()
        val rows=dao.outboxRows(s,d)
        val shift=StorePosStore.project(config,rows).shift
        val last=rows.filter {it.kind=="store.shift.open"}.maxByOrNull {it.createdAt}?.let {JSONObject(it.operationJson).getJSONObject("payload").getString("shiftId")}
            ?: StoreCheckout.objects(config.details.optJSONArray("reads")).firstOrNull()?.optString("shift_id")
        // IP-HH2: the day-end Z is read after every session is closed, so it names the last session instead of an open one.
        val zAfterClose=kind=="store.read"&&payload.optString("kind")=="z"
        val shiftId=shift?.shiftId ?: if(kind in setOf("store.deposit","store.print")||zAfterClose)checkNotNull(last){"No cashier session on this phone"} else error("Open a cashier session first")
        val z=rows.any {it.kind=="store.read" && it.status !in setOf("rejected","conflict") && JSONObject(it.operationJson).getJSONObject("payload").let {p->p.getString("shiftId")==shiftId && p.getString("kind")=="z"}}
            || StoreCheckout.objects(config.details.optJSONArray("reads")).any {it.optString("shift_id")==shiftId&&it.getString("kind")=="z"}
        check(!z||kind in setOf("store.deposit","store.print")){"Z closing has stopped sales for this day"}
        check(!zAfterClose||shift==null){"End your cashier session first. Z comes after every session is closed."}
        supervise?.let {payload.put("supervisor",it(shiftId))}
        sessions.queue(kind,shiftId,config,payload,id,shift?.openingRequestId,metadata)
    }
    /**
     * IP-REFUND: refund part of a saved sale at the till. Prices again from the frozen receipt (the same maths the office runs),
     * takes the next credit-memo number from this phone's own range, and parks ONE `store.refund.part` operation in the open session.
     * [supervise] (a supervisor's PIN proof) is required above the office's amount. The same [refundId] again returns the saved slip.
     * Returns the slip facts, which are also kept with the saved operation so a reprint is always the same slip.
     */
    suspend fun refundPart(refundId:String,saleId:String,picks:Map<Int,Long>,reasonCode:String,note:String?,expectedCentavos:Long,supervisorName:String?,supervise:((String)->JSONObject)?):RefundSlipFacts = store.db.withTransaction {
        val rows=dao.outboxRows(s,d)
        rows.firstOrNull {it.clientRequestId==refundId}?.let {old->
            val p=JSONObject(old.operationJson).getJSONObject("payload")
            if(p.getString("saleId")!=saleId||p.getString("expectedCentavos").toLong()!=expectedCentavos||p.getString("reasonCode")!=reasonCode) throw RefundNotAllowed("This refund was already saved with different details.")
            return@withTransaction RefundSlipFacts.fromJson(JSONObject(checkNotNull(old.metadataJson)))
        }
        val config=sessions.writable()
        val shift=StorePosStore.project(config,rows).shift
        val receipt=receipts(config,rows).firstOrNull {it.getString("saleId")==saleId} ?: throw RefundNotAllowed("That receipt is not on this register.")
        val ctx=StoreRefunds.context(config,rows,receipt,shift!=null,receipt.optString("_status")=="voided")
        val cleanNote=note?.trim()?.takeIf {it.isNotEmpty()}
        if(cleanNote!=null&&(cleanNote.length>300||cleanNote.any(Char::isISOControl))) throw RefundNotAllowed("The note is too long.")
        val (plan,reason,tenders)=StoreRefunds.check(ctx,picks,reasonCode,cleanNote,expectedCentavos)
        if(RefundMath.needsSupervisor(plan.totalMinor,ctx.policy.supervisorOverMinor)&&supervise==null) throw RefundNotAllowed("A supervisor has to approve this refund with their PIN.")
        val now=store.now()
        val issued=try {FiscalNumbers.issue(store.db,store.scope,JSONObject(checkNotNull(dao.meta(s,d)?.policyJson)),"credit_memo",now)}
            catch(e:IllegalStateException){throw RefundNotAllowed(if(e.message?.contains("range")==true)"No credit memo numbers left on this phone. Sync to get more." else "No credit memo numbers on this phone. Sync to get them.")}
        val registration=JSONObject(checkNotNull(dao.meta(s,d)?.policyJson)).optJSONObject("fiscal")?.optJSONArray("ranges")?.let {a->(0 until a.length()).map {a.getJSONObject(it)}.firstOrNull {it.getString("documentType")=="credit_memo"}}?.optJSONObject("registration")
        val slip=RefundSlipFacts.of(issued.number,receipt.getString("receiptNumber"),receipt.optString("customer").ifEmpty{null},receipt.optString("cashier").ifEmpty{null},
            listOf(receipt.optString("store"),receipt.optString("register")).filter {it.isNotBlank()}.joinToString(" · ").ifEmpty{null},plan,tenders,reason,cleanNote,now,
            supervisorName,registration?.optString("entityName"),registration?.optString("tin"),registration?.optString("address"),registration?.optBoolean("sample")==true)
        val payload=JSONObject().put("saleId",saleId).put("refundId",refundId)
            .put("lines",JSONArray(plan.lines.map {JSONObject().put("lineIndex",it.line.index).put("productId",it.line.productId).put("quantityBase",it.quantityBase.toString())}))
            .put("reasonCode",reason.code).put("expectedCentavos",plan.totalMinor.toString())
            .put("tenders",JSONArray(tenders.map {JSONObject().put("method",it.method).put("amountCentavos",it.amountMinor.toString())}))
            .put("fiscal",JSONObject().put("allocationId",issued.allocationId).put("serial",issued.serial.toString())).put("creditNumber",issued.number)
            .apply {cleanNote?.let {put("note",it)}}
        val shiftId=checkNotNull(shift){"Open the till first. A refund pays out of the open drawer."}.shiftId
        supervise?.let {payload.put("supervisor",it(shiftId))}
        sessions.queue(StoreRefunds.KIND,shiftId,config,payload,refundId,shift.openingRequestId,slip.toJson().toString())
        slip
    }
    suspend fun refundSlip(refundId:String):RefundSlipFacts? = dao.outbox(s,d,refundId)?.takeIf {it.kind==StoreRefunds.KIND}?.metadataJson?.let {RefundSlipFacts.fromJson(JSONObject(it))}
    suspend fun sale(saleId:String,cart:List<CartLine>,tenders:List<Tender>,expected:Long,customerPhone:String?,employeePin:String?,points:Long,claim:com.sunpride.van.selling.DiscountClaim?=null):JSONObject = store.db.withTransaction {
        val config=sessions.writable();val rows=dao.outboxRows(s,d)
        val normalizedPhone=customerPhone?.takeIf {it.isNotBlank()}?.let(StoreCheckout::normalizePhone)
        val input=JSONObject().put("lines",JSONArray(cart.map {JSONObject().put("productId",it.productId).put("quantityBase",it.quantityBase.toString())}))
            .put("tenders",JSONArray(tenders.map {JSONObject().put("method",it.method).put("amount",it.amount.toString()).put("reference",it.reference?:JSONObject.NULL).put("tendered",it.tendered?.toString()?:JSONObject.NULL)}))
            .put("expected",expected.toString()).put("phone",normalizedPhone?:JSONObject.NULL).put("employee",employeePin!=null).put("points",points.toString())
            .apply {claim?.let {put("claim",it.json("privilegeDiscountCentavos","vatRemovedCentavos",null))}}.toString()
        val hash=java.security.MessageDigest.getInstance("SHA-256").digest(input.toByteArray()).joinToString(""){"%02x".format(it.toInt() and 255)}
        rows.firstOrNull {it.clientRequestId==saleId}?.let {old->val meta=JSONObject(checkNotNull(old.metadataJson));check(meta.getString("inputHash")==hash){"Cart identifier has different content"};return@withTransaction meta.getJSONObject("receipt")}
        check(rows.none {it.kind=="store.sale" && it.status in setOf("rejected","conflict")}) {"Review the refused store sale before recording more"}
        val shift=checkNotNull(StorePosStore.project(config,rows).shift){"Open a cashier session first"}
        check(claim==null||employeePin==null&&points==0L){"A senior, PWD or other statutory discount cannot be combined with the employee discount or points"}
        val quote=StoreCheckout.quote(config,rows,cart,store.now(),claim)
        val total=StoreCheckout.total(config,quote.totalMinor,employeePin!=null,points)
        check(expected==total && total<=StorePosStore.MAX_MONEY){"Prices or discount changed"}
        require((total==0L||tenders.isNotEmpty())&&tenders.map {it.method}.distinct().size==tenders.size){"Choose how the customer pays"}
        val allowed=StoreCheckout.objects(config.details.optJSONArray("paymentMethods"))
        require(tenders.fold(0L){n,t->Math.addExact(n,t.amount)}==total){"Tenders must equal the total"}
        val methods=JSONArray()
        tenders.forEach {t->
            val rule=allowed.singleOrNull {it.getString("code")==t.method}?:error("Tender is not enabled")
            require(t.amount>0){"Each payment must be more than zero"}
            val ref=if(rule.getBoolean("referenceRequired"))checkNotNull(PaymentReference.normalize(t.reference)){"Enter the provider reference"} else null
            require(t.method!="card"||ref.orEmpty().count {it.isDigit()}<12){"Use the approval reference, never a card number"}
            if(t.method=="cash")require((t.tendered?:t.amount)>=t.amount){"Cash received is short"}
            methods.put(JSONObject().put("method",t.method).put("amountCentavos",t.amount.toString()).put("label",rule.getString("label"))
                .put("reference",ref?:JSONObject.NULL).put("tenderedCentavos",(t.tendered?:t.amount).toString()).put("changeCentavos",if(t.method=="cash")((t.tendered?:t.amount)-t.amount).toString() else "0"))
        }
        if(points>0){
            val customer=config.details.optJSONObject("customerLookup")
            check(customer?.optString("phone")==normalizedPhone){"Look up the customer before redeeming points"}
            check(points<=StoreCheckout.availablePoints(config,rows)){"Not enough available points"}
        }
        val meta=checkNotNull(dao.meta(s,d));val policy=JSONObject(checkNotNull(meta.policyJson))
        val fiscal=FiscalNumbers.issue(store.db,store.scope,JSONObject().put("fiscal",config.details.getJSONObject("fiscal")),"sales_invoice",store.now())
        val stock=JSONArray(quote.lines.map {JSONObject().put("productId",it.product.productId).put("quantityBase",it.quantityBase.toString())})
        val products=StoreCheckout.products(config).associateBy {it.productId}
        val payload=JSONObject().put("saleId",saleId).put("receiptNumber",fiscal.number).put("totalCentavos",total.toString())
            .put("lines",JSONArray(cart.map {line->val p=products.getValue(line.productId);JSONObject().put("productId",p.productId).put("uom",p.uomCode).put("quantity",p.displayQuantity(line.quantityBase)).put("quantityBase",line.quantityBase.toString())}))
            .put("stockLines",stock).put("tenders",methods).put("fiscal",JSONObject().put("allocationId",fiscal.allocationId).put("serial",fiscal.serial.toString()))
            .put("redeemPoints",points.toString()).put("loyaltyLookupId",config.details.optJSONObject("customerLookup")?.optString("lookupId")?:JSONObject.NULL).put("employeeDiscount",employeePin!=null)
            .apply {quote.claim?.let {put("discountClaim",it.json("privilegeDiscountCentavos","vatRemovedCentavos",quote.legal))}}
        normalizedPhone?.takeIf {it.isNotBlank()}?.let {payload.put("customerPhone",it)}
        employeePin?.let {payload.put("employeeProof",StoreCheckout.proof(config,it,saleId,shift.shiftId,total))}
        val extra=quote.totalMinor-total
        val allocated=quote.lines.map {if(quote.totalMinor==0L)0 else BigInteger.valueOf(extra).multiply(BigInteger.valueOf(it.totalMinor)).divide(BigInteger.valueOf(quote.totalMinor)).let(GovernedPromotions::exact)}.toMutableList()
        var rest=extra-allocated.sum();for(i in allocated.indices)if(rest>0&&allocated[i]<quote.lines[i].totalMinor){allocated[i]++;rest--}
        val receipt=JSONObject().put("saleId",saleId).put("receiptNumber",fiscal.number).put("store",config.storeName).put("register",config.registerName).put("terminal",config.terminalCode)
            .put("cashier",meta.sellerJson?.let {JSONObject(it).optString("name")}).put("customer",config.details.optJSONObject("customerLookup")?.takeIf {it.optString("phone")==normalizedPhone}?.optString("name")?:"Walk-in")
            .put("soldAt",store.now()).put("totalMinor",total.toString()).put("tenders",methods).put("fiscal",fiscal.registration)
            .put("tax",legalTax(quote.legal)?:JSONObject(FiscalNumbers.snapshot(fiscal,total)).getJSONObject("tax"))
            .apply {claim?.let {c->put("discountClaim",com.sunpride.van.printing.ReceiptDiscounts.claimJson(c,quote.legal));put("privilege",JSONObject().put("byType",JSONObject().put(c.type.wire,JSONObject().put("discountMinor",(quote.legal?.privilegeDiscount?:0L).toString()).put("vatRemovedMinor",(quote.legal?.vatRemoved?:0L).toString()))))}}
            .put("lines",JSONArray(quote.lines.mapIndexed {i,l->JSONObject().put("productId",l.product.productId).put("productCode",l.product.code).put("description",l.product.name)
                .put("uom",l.product.uomCode).put("quantity",l.product.displayQuantity(l.quantityBase)).put("quantityBase",l.quantityBase.toString())
                .put("unitPriceCentavos",l.unitPriceMinor.toString()).put("lineTotalCentavos",(l.totalMinor-allocated[i]).toString()).put("privilegeDiscountCentavos",l.privilegeDiscountMinor.toString())}))
        action("store.sale",payload,saleId,JSONObject().put("inputHash",hash).put("receipt",receipt).toString())
        receipt
    }
    suspend fun receiptRows():List<JSONObject> = receipts(sessions.writable(),dao.outboxRows(s,d))
    private val prints=store.db.receiptPrints()
    /** IP-P0: the printed-or-not history of one store receipt, in print order (the same log table as the van). */
    suspend fun printHistory(saleId:String):List<PrintAttempt> = prints.forSale(s,d,saleId).map {it.attempt()}
    suspend fun printHistories():Map<String,List<PrintAttempt>> = prints.all(s,d).groupBy({it.saleId}) {it.attempt()}
    /**
     * Decides original or reprint with the same [ReprintRules] as the van, records `started` BEFORE the printer is
     * called and queues the `store.print` journal. A re-send before "Yes, printed" is still the original.
     */
    suspend fun beginPrint(saleId:String,explicit:Boolean,reasonCode:String?):StoreBegin = store.db.withTransaction {
        val config=sessions.writable();val rows=dao.outboxRows(s,d)
        val receipt=receipts(config,rows).singleOrNull {it.getString("saleId")==saleId} ?: return@withTransaction StoreBegin.Refused(PrintRefusal.SALE_NOT_FOUND)
        val history=printHistory(saleId)
        when(val decision=ReprintRules.decide(history,explicit,reasonCode)) {
            is PrintDecision.Refused -> StoreBegin.Refused(decision.refusal)
            is PrintDecision.Print -> {
                val at=maxOf(store.now(),Math.addExact(history.maxOfOrNull {it.startedAt} ?: 0L,1L))
                val row=ReceiptPrintRow(s,d,UUID.randomUUID().toString(),saleId,decision.kind.wire,decision.copyNumber,decision.reason,PrintOutcome.STARTED.wire,at)
                prints.insert(row)
                val reprint=decision.kind==PrintKind.REPRINT
                action("store.print",JSONObject().put("saleId",saleId).put("reprint",reprint)
                    .put("reason",if(reprint)(ReprintRules.reasonLabel(decision.reason) ?: "Customer requested another copy") else "Original print").put("outcome","uncertain"))
                StoreBegin.Go(row.attempt(),document(receipt,reprint))
            }
        }
    }
    suspend fun finishPrint(printId:String,outcome:PrintOutcome) {
        require(outcome!=PrintOutcome.STARTED)
        check(prints.finish(s,d,printId,outcome.wire,store.now())==1) {"Print already finished"}
    }
    /** The seller's "Did it print?" answer for the latest sent attempt. Local only: nothing is queued. */
    suspend fun settlePrint(saleId:String,outcome:PrintOutcome) = store.db.withTransaction {
        require(outcome==PrintOutcome.CONFIRMED||outcome==PrintOutcome.SKIPPED)
        val row=prints.forSale(s,d,saleId).maxByOrNull {it.startedAt} ?: return@withTransaction
        prints.settle(s,d,row.printId,outcome.wire,store.now())
        Unit
    }
    private fun legalTax(legal:com.sunpride.van.selling.LegalCart?):JSONObject? = legal?.takeIf {it.applied}?.let {c->
        JSONObject().put("vatableSalesMinor",c.lines.sumOf {it.vatable}.toString()).put("vatMinor",c.lines.sumOf {it.vat}.toString())
            .put("vatExemptMinor",c.lines.sumOf {it.vatExempt}.toString()).put("zeroRatedMinor",c.lines.sumOf {it.zeroRated}.toString())
            .put("privilegeDiscountMinor",c.privilegeDiscount.toString()).put("vatRemovedMinor",c.vatRemoved.toString())
    }
    companion object {
        fun receipts(config:StorePosConfig,rows:List<OutboxRow>):List<JSONObject> {
            val server=StoreCheckout.objects(config.details.optJSONArray("sales"))
            val statuses=server.associate {it.getString("id") to it.getString("status")}
            val remote=server.map {it.getJSONObject("receipt")}
            val local=rows.filter {it.kind=="store.sale"&&it.metadataJson!=null}.map {JSONObject(it.metadataJson!!).getJSONObject("receipt")}
            return (local+remote).distinctBy {it.getString("saleId")}.map {JSONObject(it.toString()).put("_status",statuses[it.getString("saleId")]?:"saved")}.sortedByDescending {it.optLong("soldAt")}
        }
        fun document(r:JSONObject,reprint:Boolean=false):ReceiptDocument {
            val elements=mutableListOf<ReceiptElement>()
            fun line(v:String){elements+=ReceiptElement.Text(v)}
            r.optJSONObject("fiscal")?.let {f->line(f.optString("entityName"));line("TIN ${f.optString("tin")}");line(f.optString("address"))}
            line(r.getString("store"));line("${r.optString("register")} · ${r.optString("terminal")}")
            line("SALES INVOICE ${r.getString("receiptNumber")}")
            if(r.optJSONObject("fiscal")?.optBoolean("sample")==true)line("SAMPLE SERIES · NOT A BIR TAX INVOICE")
            if(reprint)line("REPRINT")
            line("Cashier: ${r.optString("cashier")}");line("Customer: ${r.optString("customer")}")
            line(java.time.Instant.ofEpochMilli(r.getLong("soldAt")).atZone(java.time.ZoneId.of("Asia/Manila")).toString())
            elements+=ReceiptElement.Divider()
            StoreCheckout.objects(r.getJSONArray("lines")).forEach {l->line(l.getString("description"));elements+=ReceiptElement.Columns("${l.get("quantity")} ${l.getString("uom")}",PesoAmounts.fromCentavos(l.getString("lineTotalCentavos").toLong()))}
            com.sunpride.van.printing.ReceiptDiscounts.claimLines(r){PesoAmounts.fromCentavos(it)}.forEach {(label,amount)->if(amount!=null)elements+=ReceiptElement.Columns(label,amount) else line(label)}
            elements+=ReceiptElement.Columns("TOTAL",PesoAmounts.fromCentavos(r.getString("totalMinor").toLong()),true)
            StoreCheckout.objects(r.getJSONArray("tenders")).forEach {t->elements+=ReceiptElement.Columns(t.optString("label",t.getString("method")),PesoAmounts.fromCentavos(t.getString("amountCentavos").toLong()));if(!t.isNull("reference"))line("Ref: ${t.getString("reference")}");if(t.getString("method")=="cash"){elements+=ReceiptElement.Columns("Cash received",PesoAmounts.fromCentavos(t.optString("tenderedCentavos",t.getString("amountCentavos")).toLong()));elements+=ReceiptElement.Columns("Change",PesoAmounts.fromCentavos(t.optString("changeCentavos","0").toLong()))}}
            val tax=r.getJSONObject("tax");elements+=ReceiptElement.Columns("VAT",PesoAmounts.fromCentavos(tax.getString("vatMinor").toLong()))
            elements+=ReceiptElement.Columns("VATable",PesoAmounts.fromCentavos(tax.getString("vatableSalesMinor").toLong()))
            elements+=ReceiptElement.Columns("VAT exempt",PesoAmounts.fromCentavos(tax.getString("vatExemptMinor").toLong()))
            elements+=ReceiptElement.Feed()
            return ReceiptDocument(elements,reprint)
        }
    }
}
