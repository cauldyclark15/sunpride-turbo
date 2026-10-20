package com.sunpride.van.storage

import androidx.room.withTransaction
import com.sunpride.van.data.VanPolicy
import com.sunpride.van.ledger.StockProjection
import com.sunpride.van.pos.*
import com.sunpride.van.sync.VanBootstrapCodec
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** VAN-023 stock count operation. The gateway has no stock-reconcile upload yet, so it is parked. */
const val STOCK_RECONCILE_KIND = "stock.reconcile"

class StockReconciliationStore(private val store: RoomVanStore) {
    private val db = store.db
    private val dao = db.rows()
    private val s = store.scope.fullAuthSubject
    private val d = store.scope.deviceId

    private suspend fun policy(): VanPolicy? = dao.meta(s, d)?.policyJson?.let { VanBootstrapCodec.policy(JSONObject(it)) }

    private suspend fun countable(t: TripRow): Boolean = dao.tripClose(s, d, t.tripId) == null && t.status in setOf("active", "closing", "reconciling", "review_required") ||
        dao.outboxRows(s, d).any { it.tripId == t.tripId && it.kind == "trip.start" && it.status in setOf("pending", "sending", "done") }

    /** The expected stock is the current local projection: authoritative baseline plus unsettled local movements. */
    private suspend fun expectedLines(tripId: String): List<StockCountLine> {
        val baseline = dao.truckstockbaselineRows(s, d).filter { it.tripId == tripId }
        // A refused phone fact is retained for review, but is not part of the office's expected ledger.
        val refused = if (s.startsWith("v2|")) dao.outboxRows(s,d).filter { it.status in OutboxRules.reviewStatuses }.map { it.clientRequestId }.toSet() else emptySet()
        val movements = dao.stockmovementRows(s, d).filter { it.tripId == tripId && it.clientRequestId !in refused }
        val settled = dao.movementsettlementRows(s, d).map { it.movementId }.toSet()
        val projection = StockProjection.project(baseline, movements, settled)
        val products = dao.productRows(s, d).map { VanBootstrapCodec.product(JSONObject(it.json)) }
        return StockReconciliationRules.expectedLines(products, projection)
    }

    suspend fun counted(tripId: String): Boolean = dao.stockReconciliation(s, d, tripId) != null

    suspend fun summary(): StockSummary? = db.withTransaction {
        val t = dao.trip(s, d) ?: return@withTransaction null
        val expected = expectedLines(t.tripId)
        val saved = dao.stockReconciliation(s, d, t.tripId)?.result(t.tripNumber, false)
        val products = dao.productRows(s, d).associate { it.productId to VanBootstrapCodec.product(JSONObject(it.json)) }
        val savedByLine = saved?.lines?.associateBy { it.productId to it.status } ?: emptyMap()
        StockSummary(t.tripId, t.tripNumber, store.canSync() && countable(t) && saved == null,
            expected.map { line ->
                val p = products[line.productId]
                StockLineSummary(line.productId, p?.code ?: line.productId, p?.name ?: line.productId, p?.uomCode ?: "", p?.quantityScale ?: 1L,
                    line.status, line.expectedBase, savedByLine[line.productId to line.status]?.countedBase,
                    savedByLine[line.productId to line.status]?.reasonCode)
            }, saved)
    }

    /**
     * Rechecks the screen's expected projection and writes the row, adjustment movements and parked operation in
     * one Room transaction. No refusal can leave any of those facts behind.
     */
    suspend fun commit(request: StockCountRequest): StockCountResult = db.withTransaction {
        if (!store.canSync()) throw StockRefused(StockProblem.HELD)
        val t = dao.trip(s, d) ?: throw StockRefused(StockProblem.NOT_ON_ROUTE)
        dao.stockReconciliation(s, d, t.tripId)?.let { prior ->
            val saved = linesOf(prior.linesJson)
            if (prior.reconciliationId == request.reconciliationId && saved == normalizedLines(request.lines) &&
                prior.note == StockReconciliationRules.normalizedNote(request.note) &&
                prior.approvalCode == request.approvalCode?.let { VoidApprovalCodes.normalize(it) })
                return@withTransaction prior.result(t.tripNumber, true)
            throw StockRefused(StockProblem.ALREADY_COUNTED)
        }
        if (!StockReconciliationRules.validId(request.reconciliationId)) throw StockRefused(StockProblem.COUNT_INVALID)
        if (!countable(t)) throw StockRefused(StockProblem.NOT_ON_ROUTE)
        if (request.lines.size > StockReconciliationRules.MAX_LINES) throw StockRefused(StockProblem.TOO_MANY_LINES)
        val expected = expectedLines(t.tripId)
        val supplied = normalizedLines(request.lines)
        if (supplied.size != expected.size || supplied.map { it.productId to it.status }.toSet() != expected.map { it.productId to it.status }.toSet())
            throw StockRefused(StockProblem.COUNT_INVALID)
        if (supplied.zip(expected).any { (actual, current) -> actual.productId != current.productId || actual.status != current.status || actual.expectedBase != current.expectedBase })
            throw StockRefused(StockProblem.EXPECTED_CHANGED)
        val authorization = StockReconciliationRules.authorize(policy(), t.tripId, request.reconciliationId, supplied,
            request.note, request.approvalCode)
        val batches=if(RouteOpsStore(store).version()==1) com.sunpride.van.ledger.BatchLedger(store).positions().filter {it.status in setOf("available","damaged")} else emptyList()
        if(RouteOpsStore(store).version()==1) {
            require(request.batchCounts.size==batches.size && request.batchCounts.map {it.position.lotId to it.position.status}.toSet().size==batches.size) {"Count every batch"}
            request.batchCounts.forEach {line-> require(line.countedBase>=0 && batches.singleOrNull {it.lotId==line.position.lotId && it.status==line.position.status}==line.position) {"Batch stock changed"} }
            supplied.filter {line->batches.any {it.productId==line.productId}}.forEach {line->
                require(request.batchCounts.filter {it.position.productId==line.productId && it.position.status==line.status}.sumOf {it.countedBase}==line.countedBase) {"Batch counts must match the product count"}
            }
        }
        val totals = StockReconciliationRules.summary(supplied)
        val countCode = StockReconciliationRules.countCode(t.tripId, request.reconciliationId, supplied)
        val key = UUID.randomUUID().toString()
        val now = store.now()
        val at = maxOf(now, Math.addExact(dao.latestCreatedAt(s, d) ?: 0L, 1L))
        val linesJson = linesJson(supplied)
        dao.insertStockReconciliation(StockReconciliationRow(s, d, request.reconciliationId, t.tripId, key, linesJson, countCode,
            totals.varianceLines, totals.shortBase, totals.overBase, StockReconciliationRules.normalizedNote(request.note),
            authorization.method, authorization.code, at))
        // A complete physical count supersedes older refused movements in the CURRENT projection, never their
        // immutable observations or review rows. This and the count roll back together if any write fails.
        if (s.startsWith("v2|")) {
            val refused = dao.outboxRows(s,d).filter { it.tripId == t.tripId && it.status in OutboxRules.reviewStatuses }.map { it.clientRequestId }.toSet()
            val settled = dao.movementsettlementRows(s,d).map { it.movementId }.toSet()
            dao.stockmovementRows(s,d).filter { it.tripId == t.tripId && it.clientRequestId in refused && it.movementId !in settled }
                .forEach { dao.insertSettlement(SettlementRow(s,d,it.movementId,at)) }
        }
        supplied.filter { it.expectedBase != it.countedBase }.forEach { line ->
            val delta = Math.subtractExact(line.countedBase, line.expectedBase)
            dao.insertMovement(MovementRow(s, d, "${request.reconciliationId}:${line.productId}:${line.status}:ADJUSTMENT", t.tripId,
                line.productId, "ADJUSTMENT", line.status, delta, line.reasonCode, key, at))
        }
        val payloadLines = JSONArray(supplied.sortedWith(compareBy<StockCountLine> { it.productId }.thenBy { it.status }).map { line ->
            JSONObject().put("productId", line.productId).put("status", line.status)
                .put("expectedBase", line.expectedBase.toString()).put("countedBase", line.countedBase.toString())
                .put("varianceBase", Math.subtractExact(line.countedBase, line.expectedBase).toString())
                .put("reasonCode", line.reasonCode ?: "")
        })
        val payload = JSONObject().put("tripId", t.tripId).put("reconciliationId", request.reconciliationId)
            .put("countCode", countCode).put("varianceLines", totals.varianceLines).put("shortBase", totals.shortBase.toString())
            .put("overBase", totals.overBase.toString()).put("lines", payloadLines)
            .put("approval", JSONObject().put("method", authorization.method).apply { authorization.code?.let { put("code", it) } })
            .put("deviceTime", now)
            .put("lotLines",JSONArray(request.batchCounts.map {line->val b=line.position;JSONObject().put("productId",b.productId).put("lotId",b.lotId).put("batch",b.batch).put("expiresAt",b.expiresAt?:JSONObject.NULL).put("qualityStatus",b.qualityStatus).put("status",b.status).put("expectedBase",b.quantityBase.toString()).put("countedBase",line.countedBase.toString())}))
            .apply { StockReconciliationRules.normalizedNote(request.note)?.let { put("note", it) } }
        RouteOpsStore(store).prepare(payload)
        val op = JSONObject().put("kind", STOCK_RECONCILE_KIND).put("clientRequestId", key).put("payload", payload).toString()
        // The frozen v1 validator has no count kind; V2VanCodec supplies the live v2 envelope.
        dao.insertOutbox(OutboxRow(s, d, key, t.tripId, STOCK_RECONCILE_KIND, op, at, null, store.capturedStatus))
        StockCountResult(request.reconciliationId, t.tripNumber, countCode, supplied, totals.varianceLines, totals.shortBase,
            totals.overBase, StockReconciliationRules.normalizedNote(request.note), authorization.method == "supervisor_code", at, false)
    }

    private fun normalizedLines(lines: List<StockCountLine>): List<StockCountLine> =
        lines.sortedWith(compareBy<StockCountLine> { it.productId }.thenBy { it.status })

    private fun linesJson(lines: List<StockCountLine>): String = JSONArray(normalizedLines(lines).map { line ->
        JSONObject().put("productId", line.productId).put("status", line.status).put("expectedBase", line.expectedBase.toString())
            .put("countedBase", line.countedBase.toString()).put("reasonCode", line.reasonCode ?: "")
    }).toString()

    private fun linesOf(json: String): List<StockCountLine> = VanBootstrapCodec.objects(JSONArray(json)).map { line ->
        StockCountLine(line.getString("productId"), line.getString("status"), line.getString("expectedBase").toLong(),
            line.getString("countedBase").toLong(), line.optString("reasonCode").ifEmpty { null })
    }.let(::normalizedLines)

    private fun StockReconciliationRow.result(tripNumber: String, replay: Boolean): StockCountResult =
        StockCountResult(reconciliationId, tripNumber, countCode, linesOf(linesJson), varianceLines, shortBase, overBase, note,
            approvalMethod == "supervisor_code", createdAt, replay)
}