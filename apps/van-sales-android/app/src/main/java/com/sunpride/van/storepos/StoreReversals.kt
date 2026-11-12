package com.sunpride.van.storepos

import com.sunpride.van.storage.OutboxRow
import org.json.JSONObject

/** One whole-receipt void or refund request ([kind] `void`/`refund`) and where it stands: `pending`, `approved` or `rejected`. */
data class WholeReversal(val id: String, val saleId: String, val shiftId: String?, val kind: String, val status: String)

/**
 * SP-0169 POS-026 / blind count: the whole-receipt void/refund requests of this register, as the office last sent them
 * (`reversals` in the store bundle) plus the ones this phone saved and the office has not answered yet. The office refuses an
 * item refund on a receipt with such a request, and a blind count while one is still pending; the phone says so first.
 */
object StoreReversals {
    private val KINDS = mapOf("store.void" to "void", "store.refund" to "refund")

    fun all(config: StorePosConfig, rows: List<OutboxRow>): List<WholeReversal> {
        val remote = StoreCheckout.objects(config.details.optJSONArray("reversals")).map {
            WholeReversal(it.getString("id"), it.getString("saleId"), it.optString("shiftId").ifEmpty { null }, it.getString("kind"), it.getString("status"))
        }
        val known = remote.map { it.id }.toSet()
        val local = StorePosStore.onRegister(config, rows)
            // Once sent, the office's list is the truth (a sync pulls it right after the push); only unsent requests are added.
            .filter { it.kind in KINDS && it.status in setOf("pending", "sending") && it.clientRequestId !in known }
            .map { row ->
                val p = JSONObject(row.operationJson).getJSONObject("payload")
                WholeReversal(row.clientRequestId, p.getString("saleId"), p.optString("shiftId").ifEmpty { null }, KINDS.getValue(row.kind), "pending")
            }
        return remote + local
    }

    /** The request that stops an item refund on [saleId] (waiting for the office or approved), or null. */
    fun blocking(config: StorePosConfig, rows: List<OutboxRow>, saleId: String): WholeReversal? =
        all(config, rows).firstOrNull { it.saleId == saleId && it.status != "rejected" }

    fun itemRefundProblem(r: WholeReversal): String = when {
        r.status == "pending" -> "A whole-receipt ${if (r.kind == "void") "void" else "refund"} is waiting for the office on this receipt. Refund by item only after the office rejects it."
        else -> "This receipt was already ${if (r.kind == "void") "voided" else "refunded"} in full by the office. Nothing is left to refund by item."
    }

    /** Requests in [shiftId] the office has not decided yet. */
    fun pendingInShift(config: StorePosConfig, rows: List<OutboxRow>, shiftId: String): List<WholeReversal> =
        all(config, rows).filter { it.status == "pending" && (it.shiftId == null || it.shiftId == shiftId) }

    /** Plain words for a blind count the office would refuse, or null when it can go ahead. */
    fun countProblem(pending: Int): String? = when (pending) {
        0 -> null
        1 -> "1 void or refund request is waiting for the office. A manager has to approve or reject it before you count. Sync after they decide."
        else -> "$pending void or refund requests are waiting for the office. A manager has to approve or reject them before you count. Sync after they decide."
    }
}
