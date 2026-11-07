package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.VanPolicy
import com.sunpride.van.ledger.MovementType
import com.sunpride.van.ledger.StockStatus
import com.sunpride.van.pos.*
import com.sunpride.van.printing.RefundSlipFacts
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject

/** IP-REFUND: the van's item refund, parked like a sale until the office takes it (`refund.record`). */
const val REFUND_KIND = "refund.record"

/** One sale on this trip the cashier can refund from, and everything the refund screen needs to price it. */
data class RefundContext(
    val saleId: String, val receiptNumber: String, val customerName: String, val tripId: String, val currency: String,
    val receipt: JSONObject, val lines: List<SoldLine>, val prior: Map<Int, Long>, val policy: RefundPolicy,
    val tenders: List<RefundTender>, val refundedByMethod: Map<String, Long>, val refundNumber: Int,
    /** Plain words why nothing can be refunded now (trip counted or closed, sale voided, on account...), else null. */
    val problem: String?,
) {
    val fullyRefunded: Boolean get() = lines.all { (prior[it.index] ?: 0L) >= it.quantityBase }
    fun left(line: SoldLine): Long = maxOf(0L, line.quantityBase - (prior[line.index] ?: 0L))
}

data class RefundRequest(val refundId: String, val saleId: String, val picks: Map<Int, Long>, val reasonCode: String, val note: String?,
    val expectedMinor: Long, val approvalCode: String?)

data class RefundResult(val refundId: String, val creditNumber: String, val receiptNumber: String, val customerName: String, val plan: RefundPlan,
    val tenders: List<RefundTender>, val reason: RefundReason, val note: String?, val createdAt: Long, val replay: Boolean) {
    val cashMinor: Long get() = tenders.filter { it.method == "cash" }.sumOf { it.amountMinor }
}

/** Why a refund was refused: always something a cashier can act on. */
class RefundNotAllowed(message: String) : IllegalStateException(message)

class RefundStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    private suspend fun policy(): VanPolicy? = dao.meta(s, d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)) }
    private fun payload(op: OutboxRow) = JSONObject(op.operationJson).getJSONObject("payload")
    private suspend fun refundOps(saleId: String? = null): List<JSONObject> =
        dao.outboxRows(s, d).filter { it.kind == REFUND_KIND && it.status !in setOf("rejected", "conflict") }.map(::payload)
            .filter { saleId == null || it.getJSONObject("originalSale").getString("saleId") == saleId }

    /** Every refund of this trip: those saved on this phone plus any only the office knows about (a replaced phone), once each. */
    suspend fun made(tripId: String): List<MadeRefund> {
        val local = refundOps().filter { it.getString("tripId") == tripId }.map { p ->
            MadeRefund(p.getString("refundId"), p.getJSONObject("originalSale").getString("saleId"), p.getString("creditNumber"), p.getString("expectedMinor").toLong(),
                VanBootstrapCodec.objects(p.getJSONArray("lines")).associate { it.getInt("lineIndex") to it.getString("quantityBase").toLong() },
                VanBootstrapCodec.objects(p.optJSONArray("tenders") ?: JSONArray()).groupBy { it.getString("method") }.mapValues { (_, v) -> v.sumOf { x -> x.getString("amountCentavos").toLong() } })
        }
        val known = local.map { it.id }.toSet()
        return local + (policy()?.refunds?.made?.filter { it.id !in known } ?: emptyList())
    }

    /** The cash this trip has handed back through refunds: lowers the expected cash the seller counts at the end. */
    suspend fun cashRefunds(tripId: String): Long = made(tripId).sumOf { it.tenders["cash"] ?: 0L }

    private fun original(op: JSONObject): List<RefundTender> {
        val pay = op.getJSONObject("payment")
        val parts = pay.optJSONArray("parts")
        return if (parts != null) VanBootstrapCodec.objects(parts).map { RefundTender(it.getString("method"), it.optString("label").ifEmpty { it.getString("method") }, it.getString("amountMinor").toLong()) }
        else listOf(RefundTender(pay.optString("method", "cash"), pay.optString("method", "cash"), pay.optString("amountMinor").ifEmpty { null }?.toLong() ?: op.optString("totalMinor").toLong()))
    }

    /** Reads everything from the saved sale, never from today's masters. */
    suspend fun context(saleId: String): RefundContext = db.withTransaction { read(saleId) }

    private suspend fun read(saleId: String): RefundContext {
        val sale = dao.saleRows(s, d).singleOrNull { it.saleId == saleId } ?: throw RefundNotAllowed("That receipt is not on this phone.")
        val trip = dao.trip(s, d)
        val frozen = db.receiptPrints().saleReceipt(s, d, saleId)?.let { FrozenReceipts.decode(it.documentJson).first }
            ?: throw RefundNotAllowed("That receipt is not on this phone.")
        val policy = policy()?.refunds
        val saleOp = payload(checkNotNull(dao.outbox(s, d, sale.idempotencyKey)) { "Sale without its operation" })
        val soldRows = dao.salelineRows(s, d).filter { it.saleId == saleId }.associateBy { it.lineNumber }
        val tax = frozen.fiscalJson?.let { JSONObject(it).optJSONObject("tax") }
        val receipt = JSONObject().put("totalMinor", frozen.totalMinor.toString()).put("lines", JSONArray(frozen.lines.map { l ->
            JSONObject().put("productId", l.productId).put("name", l.name).put("uomCode", l.uomCode)
                .put("quantityBase", (soldRows[l.lineNumber]?.quantityBase ?: 0L).toString())
                .put("totalMinor", l.totalMinor.toString()).put("discountMinor", l.discountMinor.toString())
                .put("grossMinor", (l.totalMinor + l.discountMinor).toString())
        })).apply { tax?.let { put("tax", it) } }
        val lines = RefundMath.saleLines(receipt)
        // Refunds of this sale: the ones saved here plus any the office knows about that this phone does not hold (a replaced phone), once each.
        val local = refundOps(saleId)
        val localIds = local.map { it.getString("refundId") }.toSet()
        val remote = policy?.made?.filter { it.saleId == saleId && it.id !in localIds } ?: emptyList()
        fun lineMap(p: JSONObject) = VanBootstrapCodec.objects(p.getJSONArray("lines")).associate { it.getInt("lineIndex") to it.getString("quantityBase").toLong() }
        fun tenderMap(p: JSONObject) = VanBootstrapCodec.objects(p.optJSONArray("tenders") ?: JSONArray()).groupBy { it.getString("method") }.mapValues { (_, v) -> v.sumOf { x -> x.getString("amountCentavos").toLong() } }
        val prior = HashMap<Int, Long>()
        (local.map(::lineMap) + remote.map { it.lines }).forEach { m -> m.forEach { (i, q) -> prior[i] = (prior[i] ?: 0L) + q } }
        // Goods already taken back through the older whole-line return flow count as returned too (same rule as the office).
        dao.outboxRows(s, d).filter { it.kind == RETURN_KIND }.map(::payload).filter { it.optJSONObject("originalSale")?.optString("saleId") == saleId }.forEach { p ->
            VanBootstrapCodec.objects(p.getJSONArray("lines")).forEach { l ->
                val i = lines.indexOfFirst { it.productId == l.getString("productId") }
                if (i >= 0) prior[i] = (prior[i] ?: 0L) + l.getString("quantityBase").toLong()
            }
        }
        val byMethod = HashMap<String, Long>()
        (local.map(::tenderMap) + remote.map { it.tenders }).forEach { m -> m.forEach { (k, v) -> byMethod[k] = (byMethod[k] ?: 0L) + v } }
        val methods = policy()?.paymentMethods ?: emptyList()
        val tenders = original(saleOp).map { t -> t.copy(label = methods.firstOrNull { it.code == t.method }?.label ?: t.label) }
        val counted = trip != null && (dao.cashReconciliation(s, d, trip.tripId) != null || dao.stockReconciliation(s, d, trip.tripId) != null || dao.tripClose(s, d, trip.tripId) != null)
        val problem = when {
            policy == null -> "Refunds by item are not turned on for this phone yet. Sync, then try again."
            !store.canSync() -> "This phone needs a current office authorization. Sync first."
            trip == null || trip.tripId != sale.tripId -> "This receipt is from another trip."
            counted -> "This trip's cash or stock is already counted. The office handles refunds now."
            dao.salevoidRows(s, d).any { it.saleId == saleId } -> "This sale was voided, so there is nothing to refund."
            dao.outboxRows(s, d).any { it.kind == "payment.record" && payload(it).optString("saleId") == saleId } || saleOp.getJSONObject("payment").optString("kind") == "credit" || frozen.paymentKind == PaymentKind.CREDIT ->
                "A sale on account cannot be refunded here. Ask the office to credit it."
            frozen.fiscalJson?.let { JSONObject(it).optString("documentType") == "official_receipt" } == true -> "A payment receipt cannot be refunded by item."
            else -> null
        }
        return RefundContext(saleId, frozen.receiptNumber, frozen.customerName, sale.tripId, frozen.currency, receipt, lines, prior, policy ?: RefundPolicy(0L, emptyList(), null, emptyList()),
            tenders, byMethod, local.size + remote.size + 1, problem)
    }

    /**
     * Saves one refund in ONE Room transaction: the rules run again on stored data, the credit-memo number comes from this phone's
     * own credit-memo range, the goods go back on the truck (sellable or damaged, by the reason), the cash leaves the trip's expected cash
     * and the parked `refund.record` operation is written. Any refusal writes nothing, including the number. The same
     * [RefundRequest.refundId] again returns the saved refund instead of refunding twice.
     */
    suspend fun commit(request: RefundRequest): RefundResult = db.withTransaction {
        val key = request.refundId
        dao.outbox(s, d, key)?.let { saved ->
            val p = payload(saved)
            if (p.getJSONObject("originalSale").getString("saleId") != request.saleId || p.getString("expectedMinor").toLong() != request.expectedMinor ||
                p.getString("reasonCode") != request.reasonCode) throw RefundNotAllowed("This refund was already saved with different details.")
            return@withTransaction rebuild(p, true)
        }
        val ctx = read(request.saleId)
        ctx.problem?.let { throw RefundNotAllowed(it) }
        val reason = ctx.policy.reason(request.reasonCode) ?: throw RefundNotAllowed("Choose why the customer is returning this.")
        val note = request.note?.trim()?.takeIf { it.isNotEmpty() }
        if (note != null && (note.length > 300 || note.any(Char::isISOControl))) throw RefundNotAllowed("The note is too long.")
        if (reason.requiresNote && note == null) throw RefundNotAllowed("Write a short note for this reason.")
        val plan = try { RefundMath.plan(ctx.receipt, ctx.prior, request.picks) } catch (e: RefundRefused) { throw RefundNotAllowed(e.message ?: "Check the items.") }
        if (plan.totalMinor != request.expectedMinor) throw RefundNotAllowed("The refund amount changed. Check the items and try again.")
        val tenders = try { RefundMath.tenders(ctx.tenders, ctx.refundedByMethod, plan.totalMinor) } catch (e: RefundRefused) { throw RefundNotAllowed(e.message ?: "Check the items.") }
        val approval = JSONObject()
        if (RefundMath.needsSupervisor(plan.totalMinor, ctx.policy.supervisorOverMinor)) {
            val k = ctx.policy.approvalKey ?: throw RefundNotAllowed("Approval codes are not available. Sync, then try again.")
            val code = request.approvalCode?.let { VoidApprovalCodes.normalize(it) } ?: throw RefundNotAllowed("Ask your supervisor for the 8-digit approval code.")
            val ok = try { RefundApprovalCodes.verify(k, ctx.tripId, ctx.receiptNumber, plan.totalMinor, reason.code, ctx.refundNumber, code) } catch (_: IllegalArgumentException) { throw RefundNotAllowed("Approval codes are not available. Sync, then try again.") }
            if (!ok) throw RefundNotAllowed("That approval code is not right for this refund.")
            approval.put("method", "supervisor_code").put("code", code)
        } else approval.put("method", "none")
        val now = store.now()
        val at = maxOf(now, Math.addExact(dao.latestCreatedAt(s, d) ?: 0L, 1L))
        val issued = try { com.sunpride.van.fiscal.FiscalNumbers.issue(db, store.scope, JSONObject(dao.meta(s, d)!!.policyJson!!), "credit_memo", now) }
            catch (e: IllegalStateException) { throw RefundNotAllowed(if (e.message?.contains("range") == true) "No credit memo numbers left on this phone. Sync to get more." else "No credit memo numbers on this phone. Sync to get them.") }
        val status = if (reason.damaged) StockStatus.damaged else StockStatus.available
        plan.lines.forEach { l -> store.recordLocalMovement(MovementType.RETURN, l.line.productId, status, l.quantityBase, "refund", key) }
        val payload = JSONObject().put("tripId", ctx.tripId).put("refundId", key)
            .put("originalSale", JSONObject().put("saleId", ctx.saleId).put("receiptNumber", ctx.receiptNumber))
            .put("lines", JSONArray(plan.lines.map { JSONObject().put("lineIndex", it.line.index).put("productId", it.line.productId).put("quantityBase", it.quantityBase.toString()) }))
            .put("reasonCode", reason.code).put("expectedMinor", plan.totalMinor.toString())
            .put("tenders", JSONArray(tenders.map { JSONObject().put("method", it.method).put("amountCentavos", it.amountMinor.toString()) }))
            .put("fiscal", JSONObject().put("allocationId", issued.allocationId).put("serial", issued.serial.toString()))
            .put("creditNumber", issued.number).put("refundNumber", ctx.refundNumber).put("approval", approval)
            .put("customerName", ctx.customerName).put("deviceTime", at)
            .apply { note?.let { put("note", it) } }
        RouteOpsStore(store).prepare(payload)
        val op = JSONObject().put("kind", REFUND_KIND).put("clientRequestId", key).put("payload", payload).toString()
        dao.insertOutbox(OutboxRow(s, d, key, ctx.tripId, REFUND_KIND, op, at, null, store.capturedStatus))
        RefundResult(key, issued.number, ctx.receiptNumber, ctx.customerName, plan, tenders, reason, note, at, false)
    }

    /** Rebuilds a saved refund from its frozen operation only. */
    private suspend fun rebuild(p: JSONObject, replay: Boolean): RefundResult {
        val saleId = p.getJSONObject("originalSale").getString("saleId")
        val ctx = read(saleId)
        val reason = ctx.policy.reason(p.getString("reasonCode")) ?: RefundReason(p.getString("reasonCode"), p.getString("reasonCode"), "sellable", false)
        val others = ctx.prior.toMutableMap()
        val mine = VanBootstrapCodec.objects(p.getJSONArray("lines")).associate { it.getInt("lineIndex") to it.getString("quantityBase").toLong() }
        mine.forEach { (i, q) -> others[i] = (others[i] ?: 0L) - q }
        val plan = RefundMath.plan(ctx.receipt, others.filterValues { it > 0L }, mine)
        val tenders = VanBootstrapCodec.objects(p.getJSONArray("tenders")).map { t -> RefundTender(t.getString("method"), ctx.tenders.firstOrNull { it.method == t.getString("method") }?.label ?: t.getString("method"), t.getString("amountCentavos").toLong()) }
        return RefundResult(p.getString("refundId"), p.getString("creditNumber"), ctx.receiptNumber, ctx.customerName, plan, tenders, reason, p.optString("note").ifEmpty { null }, p.getLong("deviceTime"), replay)
    }

    /** What the slip needs, read back from the saved refund (so a reprint is always the same slip). */
    suspend fun slip(refundId: String): RefundSlipFacts? = db.withTransaction {
        val saved = dao.outbox(s, d, refundId) ?: return@withTransaction null
        val r = rebuild(payload(saved), true)
        val fiscal = dao.meta(s, d)?.policyJson?.let { JSONObject(it).optJSONObject("fiscal")?.optJSONArray("ranges") }
            ?.let { a -> VanBootstrapCodec.objects(a).firstOrNull { it.getString("documentType") == "credit_memo" } }?.optJSONObject("registration")
        val header = currentReceiptHeader(dao, s, d, dao.trip(s, d))
        RefundSlipFacts.of(r.creditNumber, r.receiptNumber, r.customerName, header.sellerName, header.truck, r.plan, r.tenders, r.reason, r.note, r.createdAt,
            entityName = fiscal?.optString("entityName"), tin = fiscal?.optString("tin"), address = fiscal?.optString("address"), sample = fiscal?.optBoolean("sample") == true)
    }
}
