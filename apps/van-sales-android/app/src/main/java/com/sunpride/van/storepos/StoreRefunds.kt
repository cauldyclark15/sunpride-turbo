package com.sunpride.van.storepos

import com.sunpride.van.pos.*
import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.storage.RefundNotAllowed
import org.json.JSONArray
import org.json.JSONObject

/** Everything the till's refund sheet needs for one receipt, read from what this phone holds. */
data class StoreRefundContext(val receipt: JSONObject, val lines: List<SoldLine>, val prior: Map<Int, Long>, val refundedByMethod: Map<String, Long>,
    val policy: RefundPolicy, val tenders: List<RefundTender>, val refundNumber: Int, val problem: String?) {
    val fullyRefunded: Boolean get() = lines.all { (prior[it.index] ?: 0L) >= it.quantityBase }
    /** Money this sale has already had refunded by item (counts toward the supervisor amount). */
    val refundedMinor: Long get() = refundedByMethod.values.sum()
}

/** IP-REFUND (till): who has refunded what of a receipt. The office sends refunds already made (`refunds.made`); this phone adds the ones it saved and has not sent. */
object StoreRefunds {
    const val KIND = "store.refund.part"

    /** Null on a server that does not do item refunds (the phone never offered the button). */
    fun policy(config: StorePosConfig): RefundPolicy? = runCatching { RefundPolicy.decode(config.details.optJSONObject("refunds")) }.getOrNull()

    /** The document ranges this register holds, in the shape [com.sunpride.van.fiscal.FiscalNumbers.issue] reads (same source a till sale uses). */
    fun fiscalPolicy(config: StorePosConfig): JSONObject = JSONObject().apply { config.details.optJSONObject("fiscal")?.let { put("fiscal", it) } }

    /** The credit-memo registration printed on the slip, or null when this register has none. */
    fun creditMemoRegistration(policy: JSONObject): JSONObject? =
        policy.optJSONObject("fiscal")?.optJSONArray("ranges")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("documentType") == "credit_memo" } }?.optJSONObject("registration")

    /** Plain words for why no credit-memo number could be taken; never the raw sentence the sales path uses. */
    fun creditNumberProblem(raw: String?): String = when {
        raw == null -> "No credit memo number could be taken. Sync, then try again."
        raw.contains("authorized document range") -> "This register has no credit memo numbers yet. Sync, then try again."
        raw.contains("exhausted") -> "No credit memo numbers left on this register. Sync to get more."
        raw.contains("expired") -> "The credit memo numbers on this register have expired. Sync, then try again."
        raw.contains("another handheld") -> "The credit memo numbers on this register belong to another handheld. Sync, then try again."
        else -> "No credit memo number could be taken. Sync, then try again."
    }

    private fun payload(row: OutboxRow) = JSONObject(row.operationJson).getJSONObject("payload")
    private fun objects(a: JSONArray) = (0 until a.length()).map { a.getJSONObject(it) }

    /** Refunds this phone saved (not refused by the office). */
    fun local(rows: List<OutboxRow>): List<JSONObject> = rows.filter { it.kind == KIND && it.status !in setOf("rejected", "conflict") }.map(::payload)

    fun context(config: StorePosConfig, rows: List<OutboxRow>, receipt: JSONObject, shiftOpen: Boolean, voided: Boolean): StoreRefundContext {
        val policy = policy(config)
        val saleId = receipt.getString("saleId")
        val lines = RefundMath.saleLines(receipt)
        val mine = local(rows).filter { it.getString("saleId") == saleId }
        val mineIds = mine.map { it.getString("refundId") }.toSet()
        val remote = policy?.made?.filter { it.saleId == saleId && it.id !in mineIds } ?: emptyList()
        val prior = HashMap<Int, Long>()
        (mine.map { p -> objects(p.getJSONArray("lines")).associate { it.getInt("lineIndex") to it.getString("quantityBase").toLong() } } + remote.map { it.lines })
            .forEach { m -> m.forEach { (i, q) -> prior[i] = (prior[i] ?: 0L) + q } }
        val byMethod = HashMap<String, Long>()
        (mine.map { p -> objects(p.optJSONArray("tenders") ?: JSONArray()).groupBy { it.getString("method") }.mapValues { (_, v) -> v.sumOf { x -> x.getString("amountCentavos").toLong() } } } + remote.map { it.tenders })
            .forEach { m -> m.forEach { (k, v) -> byMethod[k] = (byMethod[k] ?: 0L) + v } }
        val tenders = objects(receipt.optJSONArray("tenders") ?: JSONArray()).map { RefundTender(it.getString("method"), it.optString("label").ifEmpty { it.getString("method") }, it.getString("amountCentavos").toLong()) }
        val problem = when {
            policy == null -> "Refunds by item are not turned on for this register yet. Sync, then try again."
            !shiftOpen -> "Open the till first. A refund pays out of the open drawer."
            voided -> "This sale was voided, so there is nothing to refund."
            else -> null
        }
        return StoreRefundContext(receipt, lines, prior, byMethod, policy ?: RefundPolicy(0L, emptyList(), null, emptyList()), tenders, mine.size + remote.size + 1, problem)
    }

    /** Plain words for a refund that cannot be saved, or null when [picks] can go ahead. */
    fun check(ctx: StoreRefundContext, picks: Map<Int, Long>, reasonCode: String, note: String?, expectedMinor: Long): Triple<RefundPlan, RefundReason, List<RefundTender>> {
        ctx.problem?.let { throw RefundNotAllowed(it) }
        val reason = ctx.policy.reason(reasonCode) ?: throw RefundNotAllowed("Choose why the customer is returning this.")
        if (reason.requiresNote && note.isNullOrBlank()) throw RefundNotAllowed("Write a short note for this reason.")
        val plan = try { RefundMath.plan(ctx.receipt, ctx.prior, picks) } catch (e: RefundRefused) { throw RefundNotAllowed(e.message ?: "Check the items.") }
        if (plan.totalMinor != expectedMinor) throw RefundNotAllowed("The refund amount changed. Check the items and try again.")
        val tenders = try { RefundMath.tenders(ctx.tenders, ctx.refundedByMethod, plan.totalMinor) } catch (e: RefundRefused) { throw RefundNotAllowed(e.message ?: "Check the items.") }
        return Triple(plan, reason, tenders)
    }
}
