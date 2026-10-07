package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.VanPolicy
import com.sunpride.van.pos.*
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** VAN-024 trip close operation kind. Parked like sales and the counts: the van gateway has no upload for it yet. */
const val TRIP_CLOSE_KIND = "trip.close"

/**
 * VAN-024 closing the trip on the encrypted store. The checklist is read only from this partition (the trip, its
 * saved counts, outbox, sales and print history), never typed in. The close is appended once per trip with its
 * parked `trip.close` operation in ONE Room transaction, after every rule is checked again on stored data. Once
 * closed, the trip takes no more sales, voids, returns, damage, stock changes or counts on this phone.
 */
class TripCloseStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    private suspend fun policy(): VanPolicy? = dao.meta(s, d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)) }

    private suspend fun onRoad(t: TripRow): Boolean = t.status in setOf("active", "closing", "reconciling", "review_required") ||
        dao.outboxRows(s, d).any { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending", "sending", "done") }

    /** The odometer the seller typed at Start trip, from its saved operation (null when none was typed). */
    private suspend fun startOdometer(tripId: String): Double? = dao.outboxRows(s, d)
        .firstOrNull { it.tripId == tripId && it.kind == "trip.start" }
        ?.let { JSONObject(it.operationJson).getJSONObject("payload").optDouble("odometerKm").takeIf { km -> !km.isNaN() } }

    suspend fun closed(tripId: String): Boolean = dao.tripClose(s, d, tripId) != null

    private suspend fun facts(t: TripRow): TripCloseFacts {
        val ops = dao.outboxRows(s, d).filter { it.tripId == t.tripId }
        val cash = dao.cashReconciliation(s, d, t.tripId)
        val stock = dao.stockReconciliation(s, d, t.tripId)
        val tripSales = dao.saleRows(s, d).filter { it.tripId == t.tripId }.map { it.saleId }.toSet()
        val tripMovements = dao.stockmovementRows(s, d).filter { it.tripId == t.tripId }.map { it.movementId }.toSet()
        val issues = store.saleStockIssues().count { it.saleId in tripSales || it.saleId == null && it.movementId in tripMovements }
        val unprinted = RoomReceiptPrintLog(db, store.scope).savedSales().count { it.void == null && !it.printed }
        return TripCloseFacts(onRoad(t), dao.meta(s, d)?.held != false, cash != null, stock != null,
            ops.count { it.status in setOf("pending", "sending") }, issues, unprinted,
            ops.count { it.status in OutboxRules.reviewStatuses }, cash?.varianceMinor, stock?.varianceLines)
    }

    suspend fun summary(): TripCloseSummary? = db.withTransaction {
        val t = dao.trip(s, d) ?: return@withTransaction null
        TripCloseSummary(t.tripId, t.tripNumber, startOdometer(t.tripId),
            TripCloseRules.checklist(facts(t), TripCloseRules.policy(policy())), dao.tripClose(s, d, t.tripId)?.result(t.tripNumber, false))
    }

    /**
     * Closes the trip: the checklist again on stored data, the exceptions the seller confirmed compared with the
     * current ones, then the row and the parked operation. Any refusal writes nothing. The same
     * [TripCloseRequest.closeId] with the same details returns the saved close.
     */
    suspend fun commit(request: TripCloseRequest): TripCloseResult = db.withTransaction {
        if (dao.meta(s, d)?.held != false) throw TripCloseRefused(CloseProblem.HELD)
        val t = dao.trip(s, d) ?: throw TripCloseRefused(CloseProblem.NOT_ON_ROUTE)
        val note = TripCloseRules.normalizedNote(request.note)
        dao.tripClose(s, d, t.tripId)?.let { prior ->
            if (prior.closeId == request.closeId && prior.endOdometerKm == request.endOdometerKm && prior.note == note)
                return@withTransaction prior.result(t.tripNumber, true)
            throw TripCloseRefused(CloseProblem.ALREADY_CLOSED)
        }
        val policy = TripCloseRules.policy(policy())
        val checklist = TripCloseRules.checklist(facts(t), policy)
        val reviewed = TripCloseRules.authorize(checklist, policy, request, startOdometer(t.tripId))
        val key = UUID.randomUUID().toString()
        val now = store.now()
        val at = maxOf(now, Math.addExact(dao.latestCreatedAt(s, d) ?: 0L, 1L))
        val ops = dao.outboxRows(s, d).filter { it.tripId == t.tripId }.sortedWith(compareBy<OutboxRow> { it.createdAt }.thenBy { it.clientRequestId })
        val exceptions = exceptionsJson(checklist.exceptions)
        dao.insertTripClose(TripCloseRow(s, d, request.closeId, t.tripId, key, exceptions.toString(), reviewed, request.endOdometerKm, note,
            ops.size, at))
        val cash = dao.cashReconciliation(s, d, t.tripId)
        val stock = dao.stockReconciliation(s, d, t.tripId)
        val payload = JSONObject().put("tripId", t.tripId).put("closeId", request.closeId)
            .put("cash", cash?.let { JSONObject().put("reconciliationId", it.reconciliationId).put("currency", it.currency)
                .put("expectedMinor", it.expectedMinor.toString()).put("declaredMinor", it.declaredMinor.toString())
                .put("varianceMinor", it.varianceMinor.toString()) } ?: JSONObject.NULL)
            .put("stock", stock?.let { JSONObject().put("reconciliationId", it.reconciliationId).put("countCode", it.countCode)
                .put("varianceLines", it.varianceLines).put("shortBase", it.shortBase.toString()).put("overBase", it.overBase.toString()) } ?: JSONObject.NULL)
            .put("exceptions", exceptions).put("exceptionsReviewed", reviewed)
            // The office checks it received every operation of the trip before it closes the trip there.
            .put("operations", JSONArray(ops.map { JSONObject().put("kind", it.kind).put("clientRequestId", it.clientRequestId).put("status", it.status) }))
            .put("deviceTime", now)
            .apply { request.endOdometerKm?.let { put("endOdometerKm", it) } }
            .apply { note?.let { put("note", it) } }
        val op = JSONObject().put("kind", TRIP_CLOSE_KIND).put("clientRequestId", key).put("payload", payload).toString()
        // Deliberately not sent through VanWireSchema: the gateway has no trip.close kind yet, like the counts.
        dao.insertOutbox(OutboxRow(s, d, key, t.tripId, TRIP_CLOSE_KIND, op, at, null, SALE_PARKED))
        TripCloseResult(request.closeId, t.tripNumber, checklist.exceptions, reviewed, request.endOdometerKm, note, ops.size, at, false)
    }

    private fun exceptionsJson(exceptions: List<CloseException>) = JSONArray(exceptions.map {
        JSONObject().put("kind", it.kind.wire).put("amount", it.amount.toString()) })

    private fun exceptionsOf(json: String): List<CloseException> = VanBootstrapCodec.objects(JSONArray(json)).map { o ->
        CloseException(CloseExceptionKind.entries.single { it.wire == o.getString("kind") }, o.getString("amount").toLong()) }

    private fun TripCloseRow.result(tripNumber: String, replay: Boolean) = TripCloseResult(closeId, tripNumber, exceptionsOf(exceptionsJson),
        reviewed, endOdometerKm, note, operationCount, createdAt, replay)
}
