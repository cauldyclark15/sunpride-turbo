package com.sunpride.van.storage

/** Only transport uncertainty retries; durable business refusals never automatically resume. */
object OutboxRules {
    val reviewStatuses = setOf("rejected","conflict")
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
}
