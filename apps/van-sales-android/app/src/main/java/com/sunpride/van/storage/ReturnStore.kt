package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.Customer
import com.sunpride.van.data.Product
import com.sunpride.van.ledger.MovementType
import com.sunpride.van.ledger.StockStatus
import com.sunpride.van.pos.*
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal

/** VAN-019 return operation kind. Like a sale, it is parked on this phone until the van gateway accepts returns. */
const val RETURN_KIND = "return.record"

/**
 * VAN-019 customer returns on the encrypted store. No schema change: the header and lines use the v1
 * `customer_return`/`return_line` tables (`return_line.stockStatus` = the stock effect, `reason` = the reason
 * code) and the full capture — unit, lot, expiry, disposition, approval, linked sale, note — lives in the
 * return's frozen, never-mutated `return.record` operation bytes.
 */
class ReturnStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    private suspend fun tripOpen(): Boolean {
        val t = dao.trip(s, d) ?: return false
        if (dao.meta(s, d)?.held != false) return false
        return t.status == "active" || dao.outboxRows(s, d).any { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending", "sending", "done") }
    }

    /** Sales saved on this phone (newest first), for linking a return to the receipt it came from. */
    suspend fun sales(): List<SoldSale> {
        val lines = dao.salelineRows(s, d).groupBy { it.saleId }
        return dao.saleRows(s, d).map { sale ->
            SoldSale(sale.saleId, sale.receiptNumber, sale.customerId, sale.createdAt,
                (lines[sale.saleId] ?: emptyList()).groupBy { it.productId }.mapValues { (_, l) -> l.fold(0L) { a, r -> Math.addExact(a, r.quantityBase) } })
        }.sortedByDescending { it.createdAt }
    }

    /** Per linked sale, the base quantity per product already returned against it on this phone. */
    suspend fun returnedBase(): Map<String, Map<String, Long>> {
        val result = mutableMapOf<String, MutableMap<String, Long>>()
        dao.outboxRows(s, d).filter { it.kind == RETURN_KIND }.forEach { op ->
            val p = JSONObject(op.operationJson).getJSONObject("payload")
            val sale = p.optJSONObject("originalSale")?.getString("saleId") ?: return@forEach
            val perProduct = result.getOrPut(sale) { mutableMapOf() }
            VanBootstrapCodec.objects(p.getJSONArray("lines")).forEach { line ->
                val id = line.getString("productId")
                perProduct[id] = Math.addExact(perProduct[id] ?: 0L, line.getString("quantityBase").toLong())
            }
        }
        return result
    }

    suspend fun context(): ReturnContext = ReturnContext(tripOpen(), dao.customerRows(s, d).map { it.asCustomer() },
        dao.productRows(s, d).map { VanBootstrapCodec.product(JSONObject(it.json)) }, sales(), returnedBase())

    /**
     * Saves a return in ONE Room transaction: the rules run again on stored data, then the return number
     * (shared receipt sequence), header, lines, the truck-stock RETURN movements its dispositions allow and the
     * parked `return.record` operation. Any failure leaves nothing behind, including the return number. The same
     * [ReturnRequest.returnId] again returns the saved return instead of recording it twice.
     */
    suspend fun commit(request: ReturnRequest): ReturnReceipt = db.withTransaction {
        dao.customerreturnRows(s, d).singleOrNull { it.returnId == request.returnId }?.let { return@withTransaction saved(it, request) }
        val context = context()
        val result = ReturnRules.evaluate(request, context)
        if (!result.ok) throw ReturnRefused(result.issues)
        val quote = checkNotNull(result.quote)
        val t = checkNotNull(dao.trip(s, d))
        val customer = context.customers.single { it.outletId == request.customerId }
        val id = com.sunpride.van.ids.TransactionIds(db, store.scope).issue(t.tripId, t.tripNumber)
        val now = store.now()
        val at = maxOf(now, Math.addExact(dao.latestCreatedAt(s, d) ?: 0L, 1L))
        val status = if (quote.approvalRequired) ReturnRules.STATUS_AWAITING_APPROVAL else ReturnRules.STATUS_RECORDED
        dao.insertCustomerReturn(CustomerReturnRow(s, d, request.returnId, t.tripId, id.receiptNumber, id.idempotencyKey, customer.outletId, status, at))
        quote.lines.forEach { dao.insertReturnLine(ReturnLineRow(s, d, request.returnId, it.lineNumber, it.product.productId, it.stockEffect.wire, it.quantityBase, it.reason.code)) }
        // One positive RETURN movement per product and status (deterministic IDs); thrown-away goods move nothing.
        quote.stockChanges.forEach { (key, qty) ->
            val status2 = if (key.second == ReturnStockEffect.AVAILABLE) StockStatus.available else StockStatus.damaged
            store.recordLocalMovement(MovementType.RETURN, key.first, status2, qty, MOVEMENT_REASON, id.idempotencyKey)
        }
        val customerJson = if (customer.localOnly) JSONObject().put("walkIn", JSONObject().put("name", customer.name).put("reason", customer.reason))
            else JSONObject().put("outletId", customer.outletId)
        val payload = JSONObject().put("tripId", t.tripId).put("returnId", request.returnId).put("returnNumber", id.receiptNumber)
            .put("customer", customerJson).put("customerName", customer.name).put("status", status)
            .put("approval", JSONObject().put("required", quote.approvalRequired).put("reasons", JSONArray(quote.approvalReasons.map { it.wire })))
            .put("lines", JSONArray(quote.lines.map { line ->
                // The product and unit as they were when the return was saved, so a later bootstrap that renames a
                // product, changes a case size or drops the SKU never changes what this return says.
                JSONObject().put("lineNumber", line.lineNumber).put("productId", line.product.productId)
                    .put("product", JSONObject().put("code", line.product.code).put("name", line.product.name)
                        .put("uomCode", line.product.uomCode).put("quantityScale", line.product.quantityScale.toString()))
                    .put("uomCode", line.unit.uomCode).put("uomBaseQuantity", line.unit.baseQuantity.toString())
                    .put("uomQuantity", line.unitQuantity).put("quantityBase", line.quantityBase.toString())
                    .put("reason", line.reason.code).put("reasonLabel", line.reason.label).put("disposition", line.disposition.wire).put("stockEffect", line.stockEffect.wire)
                    .put("approvalRequired", line.approvalRequired)
                    .apply { line.lotNumber?.let { put("lotNumber", it) } }
                    .apply { line.expiryDate?.let { put("expiryDate", it) } }
            }))
            .put("deviceTime", now)
        quote.sale?.let { payload.put("originalSale", JSONObject().put("saleId", it.saleId).put("receiptNumber", it.receiptNumber)) }
        quote.note?.let { payload.put("note", it) }
        val op = JSONObject().put("kind", RETURN_KIND).put("clientRequestId", id.idempotencyKey).put("payload", payload).toString()
        dao.insertOutbox(OutboxRow(s, d, id.idempotencyKey, t.tripId, RETURN_KIND, op, at, null, SALE_PARKED))
        ReturnReceipt(request.returnId, id.receiptNumber, customer.name, quote.sale?.receiptNumber, quote.lines, quote.approvalReasons, status, at)
    }

    /**
     * Rebuilds a saved return only from its rows and frozen operation, never from the current product or customer
     * master. The same return ID with any different captured detail is a [ReturnReplayConflict], not a replay.
     */
    private suspend fun saved(row: CustomerReturnRow, request: ReturnRequest): ReturnReceipt {
        val p = JSONObject(checkNotNull(dao.outbox(s, d, row.idempotencyKey)).operationJson).getJSONObject("payload")
        val lines = VanBootstrapCodec.objects(p.getJSONArray("lines"))
        val saved = ReturnCapture(row.customerId, p.optJSONObject("originalSale")?.getString("saleId"), p.optString("note").ifEmpty { null },
            lines.map { l -> ReturnCapture.Line(l.getString("productId"), l.getString("uomCode"), l.getString("quantityBase").toLong(),
                l.getString("reason"), l.getString("disposition"), l.optString("lotNumber").ifEmpty { null }, l.optString("expiryDate").ifEmpty { null }) })
        if (saved != ReturnCapture.of(request)) throw ReturnReplayConflict()
        val policy = ReturnPolicy.DEFAULT
        val quoted = lines.map { l ->
            val productId = l.getString("productId")
            val base = l.getString("quantityBase").toLong()
            val uom = l.getString("uomCode")
            // Returns saved before the snapshot was added (development builds only): the unit size follows from the
            // frozen counted quantity, and the product falls back to what this phone still knows about it.
            val unitBase = l.optString("uomBaseQuantity").ifEmpty { null }?.toLong()
                ?: BigDecimal.valueOf(base).divide(BigDecimal(l.getString("uomQuantity"))).longValueExact()
            val frozen = l.optJSONObject("product")
            val product = if (frozen != null) Product(productId, frozen.getString("code"), frozen.getString("name"), frozen.getString("uomCode"),
                frozen.getString("quantityScale").toLong(), emptyList())
            else dao.productRows(s, d).firstOrNull { it.productId == productId }?.let { VanBootstrapCodec.product(JSONObject(it.json)) }
                ?: Product(productId, productId, productId, uom, 1L, emptyList())
            val reasonCode = l.getString("reason")
            val reason = policy.reason(reasonCode)?.let { r -> l.optString("reasonLabel").ifEmpty { null }?.let { r.copy(label = it) } ?: r }
                ?: ReturnReasonRule(reasonCode, l.optString("reasonLabel").ifEmpty { reasonCode }, emptyList(), false)
            QuotedReturnLine(l.getInt("lineNumber"), product, ReturnUnit(uom, unitBase), base, reason, ReturnDisposition.of(l.getString("disposition")),
                ReturnStockEffect.entries.single { it.wire == l.getString("stockEffect") }, l.getBoolean("approvalRequired"),
                l.optString("lotNumber").ifEmpty { null }, l.optString("expiryDate").ifEmpty { null })
        }
        val reasons = p.getJSONObject("approval").getJSONArray("reasons").let { a -> (0 until a.length()).map { i -> ReturnApprovalReason.entries.single { it.wire == a.getString(i) } } }
        val customer = p.optString("customerName").ifEmpty { null } ?: p.getJSONObject("customer").optJSONObject("walkIn")?.optString("name")
            ?: dao.customerRows(s, d).singleOrNull { it.outletId == row.customerId }?.name ?: ""
        return ReturnReceipt(row.returnId, row.receiptNumber, customer, p.optJSONObject("originalSale")?.getString("receiptNumber"),
            quoted, reasons, row.status, row.createdAt, replay = true)
    }

    companion object {
        /** Ledger reason on every return movement; the per-line reason is on `return_line` and in the operation. */
        const val MOVEMENT_REASON = "customer_return"
    }
}

private fun CustomerRow.asCustomer() = Customer(outletId, code, name, address, sequence, source, reason, localOnly,
    if (creditTermsDays != null && creditAvailableMinor != null) com.sunpride.van.data.CustomerCredit(creditTermsDays, creditAvailableMinor) else null)
