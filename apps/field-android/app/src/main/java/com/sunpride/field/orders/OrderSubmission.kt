package com.sunpride.field.orders

import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Order review and submission (SP-0060, AND-015).
 *
 * A reviewed draft is submitted by queueing the visit's v1 `order_intent` activity with its lines
 * (additive optional `lines`: product, unit, whole quantity — never a price). It rides the same
 * ordered, idempotent outbox as the rest of the call: one immutable request ID per order, the
 * server visit ID filled in only after the check-in ack. The draft and the queued request are
 * written in one transaction; after that the draft is read-only and shows the outbox state.
 */
data class OrderTotals(val products: Int, val units: List<Pair<String, Int>>) {
    /** "3 products · 24 PC · 12 CAN" */
    val text: String get() = (listOf("$products product${if (products == 1) "" else "s"}") +
        units.map { (uom, n) -> "%,d %s".format(n, uom) }).joinToString(" · ")
}

/** What the person sees about a draft's journey to the office. */
enum class OrderStatus(val label: String) {
    DRAFT("Draft · not sent"),
    QUEUED("Waiting to send"),
    SENDING("Sending"),
    RECEIVED("Received by office"),
    NEEDS_REVIEW("Not accepted · needs review"),
    NOT_SENT("Not sent · call ended"),
}

/** A locally checkable business rule shown on the review screen. */
data class OrderCheck(val label: String, val problem: String?) { val ok get() = problem == null }

object OrderSubmission {
    const val KIND = "order_intent"
    private const val MAX_UOM = 20

    /** Units summed per UOM in line order; amounts are never computed (no governed price list). */
    fun totals(draft: OrderDraft): OrderTotals {
        val units = LinkedHashMap<String, Int>()
        draft.lines.forEach { units[it.uom] = (units[it.uom] ?: 0) + it.quantity }
        return OrderTotals(draft.lines.size, units.toList())
    }

    /** The exact v1 activity for [draft]: clientOrderId is the draft ID, so one order is one submission. */
    fun activity(draft: OrderDraft): JSONObject = JSONObject().put("kind", KIND).put("clientOrderId", draft.draftId)
        .put("lines", JSONArray().apply { draft.lines.forEach { l ->
            put(JSONObject().put("productId", l.productId).put("uom", l.uom).put("quantity", l.quantity))
        } })

    /** Structural equality (org.json key order is not guaranteed on the JVM). */
    fun sameActivity(a: JSONObject, b: JSONObject): Boolean {
        fun lines(o: JSONObject) = o.getJSONArray("lines").let { arr -> (0 until arr.length()).map { i ->
            arr.getJSONObject(i).let { Triple(it.getString("productId"), it.getString("uom"), it.getInt("quantity")) }
        } }
        return a.keys().asSequence().toSet() == b.keys().asSequence().toSet() && a.getString("kind") == b.getString("kind") &&
            a.getString("clientOrderId") == b.getString("clientOrderId") && lines(a) == lines(b)
    }

    /** Shape of an outgoing order activity (mirrors the v1 schema bounds). */
    fun validateActivity(activity: JSONObject) {
        require(activity.keys().asSequence().toSet() == setOf("kind", "clientOrderId", "lines"))
        require(activity.getString("kind") == KIND)
        val id = activity.getString("clientOrderId")
        require(UUID.fromString(id).toString() == id)
        val lines = activity.getJSONArray("lines")
        require(lines.length() in 1..OrderDraftRules.MAX_LINES)
        val products = (0 until lines.length()).map { i ->
            val line = lines.getJSONObject(i)
            require(line.keys().asSequence().toSet() == setOf("productId", "uom", "quantity"))
            val uom = line.getString("uom")
            require(uom.isNotEmpty() && uom.length <= MAX_UOM && uom.trim() == uom)
            val quantity = line.get("quantity")
            require(quantity is Int && quantity in 1..OrderDraftRules.MAX_QUANTITY)
            line.getString("productId").also { require(it.isNotBlank()) }
        }
        require(products.distinct().size == products.size)
    }

    /**
     * Review rules the phone can check offline, in display order. The server re-checks the account
     * setup, products, units and ownership; the phone never claims more than it can know.
     */
    suspend fun checks(store: FieldStore, draft: OrderDraft, now: Long): List<OrderCheck> {
        val sheet = store.callSheet(draft.outletId)
        val stale = OrderDraftRules.staleLines(draft, sheet)
        val ruleProblem = runCatching { OrderDraftRules.validate(store, draft.copy(submittedRequestId = null, submittedAt = null), null) }
            .exceptionOrNull()?.let { (it as? OrderDraftFailure)?.code?.text ?: "This draft no longer matches its call." }
        val callProblem = ruleProblem?.takeIf {
            it == OrderDraftFailure.Code.CALL_ENDED.text || it == OrderDraftFailure.Code.CALL_NOT_OPEN.text
        }
        return listOf(
            OrderCheck("Call is open", callProblem),
            OrderCheck("Products are set up for this account",
                if (sheet == null) OrderDraftFailure.Code.NO_CATALOG.text
                else if (stale.isNotEmpty() || sheet.revision != draft.catalogRevision) OrderDraftFailure.Code.CATALOG_CHANGED.text
                else null),
            OrderCheck("Whole quantities in each product's unit",
                if (draft.lines.isEmpty()) OrderDraftFailure.Code.EMPTY.text
                else if (draft.lines.any { it.quantity !in 1..OrderDraftRules.MAX_QUANTITY }) OrderDraftFailure.Code.INVALID_QUANTITY.text
                else null),
            OrderCheck("Phone can still record today's work",
                if (store.isLeaseValid(now)) null else OrderDraftFailure.Code.OFFLINE_EXPIRED.text),
            OrderCheck("Not sent yet", if (draft.submittedRequestId != null) OrderDraftFailure.Code.SUBMITTED.text else null),
        ).let { list ->
            // Any other rule failure (forged association, etc.) still blocks submission visibly.
            if (ruleProblem != null && list.none { it.problem == ruleProblem }) list + OrderCheck("Order matches its call", ruleProblem)
            else list
        }
    }

    /** Outbox state of the draft's request (`pending`/`sending`/`done`/`review`) → what the person sees. */
    fun status(draft: OrderDraft, rows: List<Pair<IntentRow, String>>): OrderStatus {
        val id = draft.submittedRequestId ?: return if (rows.any {
                it.first.clientVisitId == draft.clientVisitId && it.first.kind == "visit.checkOut"
            }) OrderStatus.NOT_SENT else OrderStatus.DRAFT
        return when (rows.firstOrNull { it.first.requestId == id }?.second) {
            "done" -> OrderStatus.RECEIVED
            "sending" -> OrderStatus.SENDING
            "pending", null -> OrderStatus.QUEUED
            else -> OrderStatus.NEEDS_REVIEW
        }
    }

    /** Build the queued request for [draft]: depends on the call's latest request, after its check-in. */
    fun intent(scope: StoreScope, draft: OrderDraft, previousRequestId: String, now: Long): IntentRow =
        VisitIntentFactory.create(scope, "visit.activity", draft.clientVisitId, draft.checkInRequestId,
            previousRequestId, null, draft.outletId, emptyList(), null, null, null, null, null, at = now,
            activity = activity(draft))
}

/**
 * Store-side guard run inside the enqueue transaction: an `order_intent` request must match an
 * unsent local draft of the same call exactly. A forged or duplicate order never reaches the outbox.
 */
object OrderQueueRules {
    suspend fun validate(store: FieldStore, intent: IntentRow) {
        if (intent.kind != "visit.activity") return
        val payload = runCatching { JSONObject(intent.serializedOperation).optJSONObject("payload") }.getOrNull() ?: return
        val activity = payload.optJSONObject("activity") ?: return
        if (activity.optString("kind") != OrderSubmission.KIND) return
        OrderSubmission.validateActivity(activity)
        val draft = store.orderDrafts().firstOrNull { it.draftId == activity.getString("clientOrderId") }
            ?: throw OrderDraftFailure(OrderDraftFailure.Code.CALL_NOT_OPEN)
        if (draft.submittedRequestId != null) throw OrderDraftFailure(OrderDraftFailure.Code.SUBMITTED)
        require(draft.clientVisitId == intent.clientVisitId &&
            payload.getString("visitId") == "@checkin:${draft.checkInRequestId}") { "Order does not match its call" }
        require(OrderSubmission.sameActivity(OrderSubmission.activity(draft), activity)) { "Order lines changed" }
        OrderDraftRules.validate(store, draft, null)
    }
}

/** Shared by the live and test backends: queue [draftId] and mark it sent in one store transaction. */
suspend fun submitOrderDraftIn(store: FieldStore, scope: StoreScope, draftId: String, previousRequestId: String,
    now: Long): OrderDraft {
    val draft = store.orderDrafts().firstOrNull { it.draftId == draftId } ?: error("Unknown draft")
    if (draft.submittedRequestId != null) throw OrderDraftFailure(OrderDraftFailure.Code.SUBMITTED)
    val intent = OrderSubmission.intent(scope, draft, previousRequestId, now)
    store.submitOrderDraft(draftId, intent, now)
    return store.orderDrafts().first { it.draftId == draftId }
}
