package com.sunpride.field.ui.syncstatus

import com.sunpride.field.storage.OutboxRow
import com.sunpride.field.storage.PartitionRow

/** A local Room projection only. Connectivity affects the label, never the durable counts. */
data class SyncStatus(
    val queued: Int = 0, val sending: Int = 0, val review: Int = 0, val held: Int = 0,
    val lastSuccess: Long? = null, val leaseExpiresAt: Long? = null,
    val cacheExpiresAt: Long? = null, val health: String = "never_synced",
    val offline: Boolean = false, val reviewReasons: List<String> = emptyList()
) {
    val pending get() = queued + sending + review + held > 0
    fun leaseExpired(now: Long) = leaseExpiresAt == null || now >= leaseExpiresAt
    fun cacheStale(now: Long) = cacheExpiresAt == null || now >= cacheExpiresAt
    fun label(now: Long): String = when {
        held > 0 || health == "held_for_review" -> "Held · needs review"
        review > 0 -> "Needs review · not synced"
        queued > 0 || sending > 0 -> "Queued · not synced"
        offline -> "Offline · saved data"
        leaseExpired(now) -> "Lease expired · not synced"
        cacheStale(now) -> "Cache stale · not synced"
        health == "synced" && lastSuccess != null -> "All synced"
        else -> "Sync pending"
    }

    companion object {
        fun fromRoom(partition: PartitionRow?, rows: List<OutboxRow>, offline: Boolean = false): SyncStatus {
            val current = rows.filter { it.scope == partition?.scope }
            val held = rows.count { it.scope != partition?.scope && it.state != "done" } +
                if (partition?.held == true) current.count { it.state != "done" } else 0
            val active = if (partition?.held == true) emptyList() else current
            return SyncStatus(active.count { it.state == "pending" }, active.count { it.state == "sending" },
                active.count { it.state == "review" }, held, partition?.lastSuccessfulSync,
                partition?.leaseExpiresAt, partition?.cacheExpiresAt, partition?.syncHealth ?: "never_synced",
                offline, rows.filter { it.state == "review" }.map { plainReason(it.rejectionCode) })
        }

        /** Never render a server-supplied free-form rejection or payload. */
        fun plainReason(code: String?): String = when (code) {
            "dependency_missing" -> "Check-in was not accepted; dependent visit needs review"
            "rebootstrap_visit_changed" -> "Visit changed since it was queued"
            "conflict" -> "Server reported a conflict"
            "rejected" -> "Server rejected this visit"
            else -> "Visit needs administrator review"
        }
    }
}
