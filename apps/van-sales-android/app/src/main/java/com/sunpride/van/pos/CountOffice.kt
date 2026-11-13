package com.sunpride.van.pos

import org.json.JSONArray

/**
 * VAN-079: the end-of-day counts and the office.
 * - A damage report over the limit waits for a supervisor. Its decision changes the truck stock (a rejection puts
 *   the goods back to sellable), so the stock count is not taken until it is decided and synced.
 * - The office keeps a stock count sent while a damage still waits (temporary refusal): the phone keeps it and
 *   sends it again ([WAITING_DAMAGE_CODE]).
 * - A count the office refused for good is not a count: the seller is told why in plain words and counts again.
 */
object CountOfficeRules {
    const val CASH_KIND = "cash.reconcile"
    const val STOCK_KIND = "stock.reconcile"
    /** Outbox code kept on a still-pending stock count the office answered "a damage is waiting" (temporary). */
    const val WAITING_DAMAGE_CODE = "waiting_damage_decision"

    fun isCount(kind: String): Boolean = kind == CASH_KIND || kind == STOCK_KIND

    /** The office's temporary refusal of a stock count: a damage report still waits for a supervisor. */
    fun waitsForDamage(opType: String, code: String?, retryable: Boolean): Boolean =
        retryable && opType == STOCK_KIND && code == "evidence_pending_review"

    /**
     * Why counting the stock must wait, in plain words (null = it can be counted now). [damageRecords] is the trip's
     * `damageRecords` from the last download; [unsentDamage] is true while a damage saved here has not reached the office.
     */
    fun damageWaiting(damageRecords: JSONArray?, unsentDamage: Boolean): String? {
        val waiting = damageRecords?.let { a -> (0 until a.length()).count { a.optJSONObject(it)?.optString("status") == "pending_approval" } } ?: 0
        return when {
            unsentDamage -> "A damage report is not sent to the office yet. Sync first, then count the stock."
            waiting > 0 -> "A damage report is waiting for a supervisor's decision. The decision can change the truck stock. " +
                "Ask your supervisor to decide it, then sync and count the stock."
            else -> null
        }
    }

    /** The plain reason a count was refused by the office, and what to do now. */
    fun refusal(kind: String, code: String?): String {
        val what = if (kind == CASH_KIND) "cash count" else "stock count"
        val again = if (kind == CASH_KIND) "Count the cash again." else "Sync, then count the stock again."
        val why = when (code) {
            "stock_conflict" -> if (kind == CASH_KIND) "the office's expected cash changed after your count (a sale or refund was changed or refused)."
                else "the office's truck stock changed after your count (for example a damage decision or a refused sale)."
            "evidence_pending_review" -> "a damage report was waiting for a supervisor's decision."
            "idempotency_conflict" -> "the office already has a different count for this trip. Ask your supervisor before counting again."
            "wrong_date" -> "it was not saved on the trip's day. Check the phone's date and time."
            "out_of_scope" -> "this trip belongs to another seller or phone. Ask your supervisor."
            else -> "the office could not accept it."
        }
        return "The office refused your $what: $why" + if (code in setOf("idempotency_conflict", "out_of_scope")) "" else " $again"
    }

    /** What the seller reads on a saved stock count still waiting at the office. */
    const val WAITING_DAMAGE_TEXT = "Waiting for the office: a damage report needs a supervisor's decision. Your count is sent again after it is decided."
}
