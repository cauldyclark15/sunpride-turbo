package com.sunpride.van.storage

/** Only transport uncertainty retries; durable business refusals never automatically resume. */
object OutboxRules {
    val reviewStatuses = setOf("rejected","conflict")
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
