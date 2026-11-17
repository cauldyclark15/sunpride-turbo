package com.sunpride.field.sell.storage

/** Only transport uncertainty retries; durable business refusals never automatically resume. */
object OutboxRules {
    /**
     * SP-0190: the server refused this op for good AND kept a full copy for the office (`kept: true`). The phone lets
     * go of it: no seller screen lists it, but every business rule treats it exactly like a refusal (its stock and
     * cash never happened at the office).
     */
    const val OFFICE = "office"
    /** Terminal refused states. [OFFICE] behaves like `rejected`/`conflict` for every business check. */
    val REFUSED = setOf("rejected","conflict",OFFICE)
    /** Refusals the office did not confirm it kept (older server). Kept for business rules; never listed for the seller. */
    val UNKEPT = setOf("rejected","conflict")
    val reviewStatuses = REFUSED
    /**
     * r6van4: operations the office refused for good on a v2 scope ([fullAuthSubject] starts with `v2|`). What they
     * recorded on the phone (a sale's truck-stock deduction, its cash) never happened at the office, so stock and
     * expected cash leave them out exactly as the office does.
     */
    fun refused(fullAuthSubject: String, rows: Collection<OutboxRow>): Set<String> =
        if (fullAuthSubject.startsWith("v2|")) rows.filter { it.status in reviewStatuses }.map { it.clientRequestId }.toSet() else emptySet()
    fun sending(status: String): String = if (status == "pending") "sending" else status
    fun interrupted(status: String): String = if (status == "sending") "pending" else status
    fun acknowledge(status: String, hasDurableAck: Boolean): String {
        check(hasDurableAck && status in setOf("pending","sending","done"))
        return "done"
    }
    fun reject(status: String, outcome: String): String {
        require(outcome in reviewStatuses)
        return if (status in setOf("pending","sending")) outcome else status
    }
    /** The stored state for a refusal: [OFFICE] when the server said it kept a copy, else the refusal itself. */
    fun refusedState(status: String, kept: Boolean): String = if (kept) OFFICE else status

    /** Kinds never put back by the one-time resend: a refused count was dropped here and the seller counted again. */
    val NO_RESEND_KINDS = setOf("cash.reconcile","stock.reconcile")
    /**
     * SP-0190 one-time resend after this update: refused rows go back to `pending` with their bytes untouched, so the
     * normal sync sends the identical op again and the server's own checks decide (it keeps a copy if it refuses again).
     * Not resent: counts ([NO_RESEND_KINDS]) and receipts whose number the office already spoiled (their goods and cash
     * were reversed on this phone; resending could only be refused again).
     */
    fun resendOnce(row: OutboxRow): Boolean = row.status in UNKEPT && row.kind !in NO_RESEND_KINDS &&
        row.rejectionCode != com.sunpride.field.sell.selling.RefusedReceipt.CODE
    /** The same rule as [resendOnce], as SQL for the one-time database migration. */
    const val RESEND_SQL = "UPDATE sell_outbox SET status='pending', rejectionCode=NULL WHERE status IN ('rejected','conflict') " +
        "AND kind NOT IN ('cash.reconcile','stock.reconcile') AND (rejectionCode IS NULL OR rejectionCode <> 'receipt_spoiled')"
}
