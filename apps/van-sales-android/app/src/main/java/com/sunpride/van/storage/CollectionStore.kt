package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.*
import com.sunpride.van.pos.PaymentReference
import com.sunpride.van.pos.CheckoutRules
import com.sunpride.van.fiscal.FiscalNumbers
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

/** F-111: shared validation used by the offline capture transaction. */
object CollectionRules {
    fun reference(method: PaymentMethod, amount: Long, remaining: Long, reference: String?): String? {
        require(method.kind != PaymentKind.CREDIT) { "A collection must receive money, not more credit" }
        require(amount > 0 && amount <= remaining && amount <= CheckoutRules.MAX_MINOR) { "Enter an amount within the remaining invoice" }
        if(!method.referenceRequired) return null
        val normalized=PaymentReference.normalize(reference)
        require(normalized != null && !(method.code == "card" && normalized.count(Char::isDigit)>=12)) { "Enter a payment reference, never a card number" }
        return normalized
    }
}

/** F-019/F-108/F-109/F-111: OR, payment and immutable upload are one existing Room transaction.
 * No sale/stock row is inserted for a collection; SAP remains the receivables authority. */
class CollectionStore(private val store: RoomVanStore) {
    private val db=store.db
    private val dao=db.rows()
    private val s=store.scope.fullAuthSubject
    private val d=store.scope.deviceId
    suspend fun record(paymentId: String, saleId: String, amount: Long, methodCode: String, reference: String?): SaleReceipt = db.withTransaction {
        UUID.fromString(paymentId)
        check(store.canSync()) { "Verify this phone and its current day before collecting" }
        val trip=checkNotNull(dao.trip(s,d))
        val original=dao.saleRows(s,d).singleOrNull {it.saleId==saleId && it.tripId==trip.tripId} ?: error("Choose an invoice from this trip")
        val frozen=checkNotNull(db.receiptPrints().saleReceipt(s,d,saleId)) { "The original invoice snapshot is missing" }
        val invoice=FrozenReceipts.decode(frozen.documentJson).first
        check(invoice.paymentKind == PaymentKind.CREDIT && dao.saleVoid(s,d,saleId)==null) { "Only an unvoided on-account invoice can receive a collection" }
        val policy=JSONObject(checkNotNull(dao.meta(s,d)?.policyJson))
        val method=VanBootstrapCodec.policy(policy).paymentMethods.singleOrNull {it.code==methodCode} ?: error("Payment method is not enabled")
        val ops=dao.outboxRows(s,d).filter {it.kind=="payment.record" && it.tripId==trip.tripId}
        val prior=ops.firstOrNull {JSONObject(it.operationJson).getJSONObject("payload").getString("paymentId")==paymentId}
        if(prior != null) {
            val p=JSONObject(prior.operationJson).getJSONObject("payload")
            check(p.getString("saleId")==saleId && p.getString("amountMinor").toLong()==amount && p.getString("method")==methodCode && p.optString("reference").ifBlank {null}==reference?.let(PaymentReference::normalize)) { "This collection was already saved with different facts" }
            return@withTransaction FrozenReceipts.decode(checkNotNull(db.receiptPrints().saleReceipt(s,d,paymentId)).documentJson).first
        }
        check(dao.tripClose(s,d,trip.tripId)==null && dao.cashReconciliation(s,d,trip.tripId)==null && dao.stockReconciliation(s,d,trip.tripId)==null) { "The trip is already being settled" }
        check(trip.status=="active" || dao.outboxRows(s,d).any {it.tripId==trip.tripId && it.kind=="trip.start" && it.status in setOf("pending","sending","done")}) { "Start the trip before collecting" }
        val paid=ops.map {JSONObject(it.operationJson).getJSONObject("payload")}.filter {it.getString("saleId")==saleId}.fold(0L) {sum,p->Math.addExact(sum,p.getString("amountMinor").toLong())}
        val normalized=CollectionRules.reference(method,amount,Math.subtractExact(invoice.totalMinor,paid),reference)
        if(normalized != null) check(dao.paymentRows(s,d).none {it.method==methodCode && it.reference==normalized}) { "That payment reference is already recorded" }
        val now=store.now(); val at=maxOf(now,Math.addExact(dao.latestCreatedAt(s,d)?:0L,1L))
        val issued=FiscalNumbers.issue(db,store.scope,policy,"official_receipt",now)
        val fiscal=JSONObject(FiscalNumbers.snapshot(issued,amount,"official_receipt")).put("invoiceNumber",invoice.receiptNumber)
        val key=UUID.randomUUID().toString()
        val status=if(method.kind==PaymentKind.CASH) "paid" else "awaiting_confirmation"
        val receipt=SaleReceipt(paymentId,issued.number,invoice.customerName,emptyList(),invoice.currency,amount,amount,0,at,false,method.code,method.label,method.kind,status,normalized,null,fiscal.toString())
        dao.insertPayment(PaymentRow(s,d,paymentId,saleId,method.code,amount,at,normalized,status,if(method.kind==PaymentKind.CASH)amount else null))
        val payload=JSONObject().put("tripId",trip.tripId).put("saleId",saleId).put("paymentId",paymentId).put("method",method.code)
            .put("amountMinor",amount.toString()).put("deviceTime",now).put("fiscal",JSONObject().put("allocationId",issued.allocationId).put("serial",issued.serial.toString()))
        normalized?.let {payload.put("reference",it)}
        RouteOpsStore(store).prepare(payload)
        val op=JSONObject().put("kind","payment.record").put("clientRequestId",key).put("payload",payload).put("dependsOn",JSONArray().put(original.idempotencyKey))
        dao.insertOutbox(OutboxRow(s,d,key,trip.tripId,"payment.record",op.toString(),at,null,store.capturedStatus))
        db.receiptPrints().insertSaleReceipt(SaleReceiptRow(s,d,paymentId,FrozenReceipts.encode(receipt,currentReceiptHeader(dao,s,d,trip))))
        receipt
    }
    /** Printable document view only; these are NEVER inserted into sale or stock tables. */
    suspend fun printableCollections(): List<SaleRow> {
        val tripId=dao.trip(s,d)?.tripId ?: return emptyList()
        return dao.outboxRows(s,d).filter {it.tripId==tripId && it.kind=="payment.record"}.map {op->
            val p=JSONObject(op.operationJson).getJSONObject("payload")
            val id=p.getString("paymentId")
            val receipt=FrozenReceipts.decode(checkNotNull(db.receiptPrints().saleReceipt(s,d,id)).documentJson).first
            SaleRow(s,d,id,tripId,receipt.receiptNumber,op.clientRequestId,"","collection",receipt.totalMinor,receipt.createdAt,receipt.paymentStatus)
        }
    }
}
