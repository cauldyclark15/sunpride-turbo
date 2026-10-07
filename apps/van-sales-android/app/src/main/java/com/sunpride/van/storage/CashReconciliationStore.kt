package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.PaymentMethod
import com.sunpride.van.data.VanPolicy
import com.sunpride.van.pos.*
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** VAN-022 cash count operation kind. Parked like sales: the van gateway has no upload for it yet. */
const val CASH_RECONCILE_KIND = "cash.reconcile"

/** What the Count cash screen shows: the trip, what is expected, and the saved count once there is one. */
data class CashSummary(val tripId: String, val tripNumber: String, val countable: Boolean, val expectation: CashExpectation,
    val saved: CashCountResult?)

/**
 * VAN-022 end-of-trip cash count on the encrypted store. Expected cash is read only from this partition's saved
 * sales and their frozen sale operations (never typed in); the count is appended once per trip with its parked
 * `cash.reconcile` operation in ONE Room transaction. After it is saved the trip sells and voids nothing more
 * (`RoomVanStore` checks [counted]), so the expected cash the supervisor approved cannot change afterwards.
 */
class CashReconciliationStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    private suspend fun policy(): VanPolicy? = dao.meta(s, d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)) }

    /** The trip went on the road (or its start is saved here): cash can be counted. */
    private suspend fun countable(t: TripRow): Boolean = t.status in setOf("active", "closing", "reconciling", "review_required") ||
        dao.outboxRows(s, d).any { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending", "sending", "done") }

    /** Every payment saved on this phone for [tripId], as frozen in its sale operation (method, kind, amount, currency). */
    suspend fun payments(tripId: String): List<TripPayment> {
        val voided = dao.salevoidRows(s, d).map { it.saleId }.toSet()
        val methods = policy()?.paymentMethods ?: PaymentMethod.CASH_ONLY
        val ops = dao.outboxRows(s, d).filter { it.kind == SALE_KIND }.associateBy { it.clientRequestId }
        return dao.saleRows(s, d).filter { it.tripId == tripId }.sortedBy { it.createdAt }.map { sale ->
            val payload = JSONObject(checkNotNull(ops[sale.idempotencyKey]) { "Sale without its operation" }.operationJson).getJSONObject("payload")
            val payment = payload.getJSONObject("payment")
            // A sale saved before VAN-012 has {"terms":"cash"}: cash for the whole total.
            val code = payment.optString("method", "cash")
            val kind = PaymentKind.of(payment.optString("kind", if (code == "cash") "cash" else "other"))
            val amount = payment.optString("amountMinor").ifEmpty { null }?.toLong() ?: checkNotNull(sale.totalMinor)
            TripPayment(sale.saleId, sale.receiptNumber, code, methods.firstOrNull { it.code == code }?.label ?: code, kind, amount,
                payload.getString("currency"), sale.saleId in voided)
        }
    }

    /** True once this trip's cash is counted on this phone; selling and voiding then stop. */
    suspend fun counted(tripId: String): Boolean = dao.cashReconciliation(s, d, tripId) != null

    suspend fun summary(): CashSummary? = db.withTransaction {
        val t = dao.trip(s, d) ?: return@withTransaction null
        val saved = dao.cashReconciliation(s, d, t.tripId)
        CashSummary(t.tripId, t.tripNumber, dao.meta(s, d)?.held == false && countable(t) && saved == null,
            CashReconciliationRules.expectation(payments(t.tripId)), saved?.result(t.tripNumber, false))
    }

    /**
     * Saves the count: rules again on stored data, the expected cash recomputed and compared with what the seller
     * saw ([CashCountRequest.expectedMinor]), then the row and the parked operation. Any refusal writes nothing.
     * The same [CashCountRequest.reconciliationId] with the same count returns the saved count.
     */
    suspend fun commit(request: CashCountRequest): CashCountResult = db.withTransaction {
        if (dao.meta(s, d)?.held != false) throw CashRefused(CashProblem.HELD)
        val t = dao.trip(s, d) ?: throw CashRefused(CashProblem.NOT_ON_ROUTE)
        dao.cashReconciliation(s, d, t.tripId)?.let { prior ->
            if (prior.reconciliationId == request.reconciliationId && countsOf(prior.countsJson) == request.counts.filterValues { it != 0L } &&
                prior.reasonCode == request.reasonCode.takeIf { prior.varianceMinor != 0L } &&
                prior.note == CashReconciliationRules.normalizedNote(request.note))
                return@withTransaction prior.result(t.tripNumber, true)
            throw CashRefused(CashProblem.ALREADY_COUNTED)
        }
        require(CashReconciliationRules.validId(request.reconciliationId)) { "Reconciliation ID must be a UUID-v4" }
        if (!countable(t)) throw CashRefused(CashProblem.NOT_ON_ROUTE)
        val expectation = CashReconciliationRules.expectation(payments(t.tripId))
        if (expectation.expectedMinor != request.expectedMinor) throw CashRefused(CashProblem.EXPECTED_CHANGED)
        val declared = CashReconciliationRules.declared(request.counts) ?: throw CashRefused(CashProblem.COUNT_INVALID)
        val authorized = CashReconciliationRules.authorize(policy(), t.tripId, expectation.expectedMinor, declared,
            request.reasonCode, request.note, request.approvalCode)
        val variance = Math.subtractExact(declared, expectation.expectedMinor)
        val key = UUID.randomUUID().toString()
        val now = store.now()
        val at = maxOf(now, Math.addExact(dao.latestCreatedAt(s, d) ?: 0L, 1L))
        val counts = request.counts.filterValues { it != 0L }
        val countsJson = JSONArray(CashDenominations.PHP.filter { it.minor in counts }.map {
            JSONObject().put("denominationMinor", it.minor.toString()).put("count", counts.getValue(it.minor).toString()) })
        val row = CashReconciliationRow(s, d, request.reconciliationId, t.tripId, key, expectation.currency, expectation.expectedMinor,
            declared, variance, countsJson.toString(), authorized.reasonCode, authorized.note, authorized.method, authorized.code,
            expectation.cashSales, at)
        dao.insertCashReconciliation(row)
        val payload = JSONObject().put("tripId", t.tripId).put("reconciliationId", request.reconciliationId)
            .put("currency", expectation.currency).put("expectedMinor", expectation.expectedMinor.toString())
            .put("declaredMinor", declared.toString()).put("varianceMinor", variance.toString())
            .put("counts", countsJson).put("cashSales", expectation.cashSales).put("voidedSales", expectation.voidedSales)
            .put("otherPayments", JSONArray(expectation.others.map { JSONObject().put("method", it.code).put("kind", it.kind.wire)
                .put("count", it.count).put("amountMinor", it.amountMinor.toString()) }))
            .put("approval", JSONObject().put("method", authorized.method).apply { authorized.code?.let { put("code", it) } })
            .put("deviceTime", now)
            .apply { authorized.reasonCode?.let { put("reasonCode", it) } }
            .apply { authorized.note?.let { put("note", it) } }
        val op = JSONObject().put("kind", CASH_RECONCILE_KIND).put("clientRequestId", key).put("payload", payload).toString()
        dao.insertOutbox(OutboxRow(s, d, key, t.tripId, CASH_RECONCILE_KIND, op, at, null, SALE_PARKED))
        row.result(t.tripNumber, false)
    }

    private fun countsOf(json: String): Map<Long, Long> = VanBootstrapCodec.objects(JSONArray(json))
        .associate { it.getString("denominationMinor").toLong() to it.getString("count").toLong() }
    private fun CashReconciliationRow.result(tripNumber: String, replay: Boolean) = CashCountResult(reconciliationId, tripNumber, currency,
        expectedMinor, declaredMinor, varianceMinor, reasonCode, note, approvalMethod == "supervisor_code", countsOf(countsJson), createdAt, replay)
}
