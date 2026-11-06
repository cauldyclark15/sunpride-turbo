package com.sunpride.van.storage

/** One saved `load.confirm` on this phone: its request id, outbox status and when it was saved. */
data class ConfirmFact(val clientRequestId: String, val status: String, val createdAt: Long)

/**
 * IP-P0: when may the seller send a (new) load count?
 *
 * The office can send a counted load back ("Reject and recount"). The server puts the load back to `planned` and its
 * bundle names the count it last saw (`confirmRequestId`). A count the phone already sent and had acknowledged (`done`)
 * is then answered, so a fresh count is allowed. While a count is still waiting to go (`pending`, `sending`), or was
 * acknowledged but no bundle has shown it yet, a second one would double-count the load, so it is refused.
 */
object LoadRecount {
    /** The newest count was acknowledged but the office's bundle does not show it yet (planned load only). */
    fun waitingForOffice(confirms: List<ConfirmFact>, serverConfirmRequestId: String?): Boolean {
        val latest = confirms.maxByOrNull { it.createdAt } ?: return false
        return latest.status == "done" && latest.clientRequestId != serverConfirmRequestId
    }
    /** True when no count is in flight and the newest acknowledged count is the one the office sent back. */
    fun mayConfirm(confirms: List<ConfirmFact>, serverConfirmRequestId: String?): Boolean =
        confirms.none { it.status == "pending" || it.status == "sending" } && !waitingForOffice(confirms, serverConfirmRequestId)
}
