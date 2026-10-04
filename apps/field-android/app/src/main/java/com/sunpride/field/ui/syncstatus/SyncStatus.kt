package com.sunpride.field.ui.syncstatus

import com.sunpride.field.storage.OutboxRow
import com.sunpride.field.storage.PartitionRow
import com.sunpride.field.storage.IntentRow
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val manila = ZoneId.of("Asia/Manila")
fun dayClose(serviceDate: String): Long = LocalDate.parse(serviceDate).atTime(22, 0).atZone(manila).toInstant().toEpochMilli()
fun dayCloseFor(time: Long): Long = dayClose(Instant.ofEpochMilli(time).atZone(manila).toLocalDate().toString())
fun closeTime(time: Long?): String = time?.let {
    DateTimeFormatter.ofPattern("MMM d, yyyy hh:mm a", Locale.ENGLISH).format(Instant.ofEpochMilli(it).atZone(manila)) + " · Asia/Manila"
} ?: "Never"

/** A local Room projection only. Connectivity affects the label, never the durable counts. */
data class SyncStatus(
    val queued: Int = 0, val sending: Int = 0, val review: Int = 0, val held: Int = 0,
    val lastSuccess: Long? = null, val leaseExpiresAt: Long? = null,
    val cacheExpiresAt: Long? = null, val health: String = "never_synced",
    val offline: Boolean = false, val reviewReasons: List<String> = emptyList(),
    val earliestUnsentCloseAt: Long? = null,
    /** AND-016 photos saved on the phone and not yet uploaded. Never blocks visit sync or End. */
    val photosWaiting: Int = 0
) {
    val pending get() = queued + sending + review + held > 0
    fun leaseExpired(now: Long) = leaseExpiresAt == null || now >= leaseExpiresAt
    fun cacheStale(now: Long) = cacheExpiresAt == null || now >= cacheExpiresAt
    fun label(now: Long): String = when {
        held > 0 || health == "held_for_review" -> "Held · needs review"
        review > 0 -> "Needs review · not synced"
        queued > 0 || sending > 0 -> if (now >= (earliestUnsentCloseAt ?: dayCloseFor(now)))
            "Late · held for review" else "Sync before 10 PM"
        offline -> "Offline · saved data"
        leaseExpired(now) -> "Day closed · sync for access"
        cacheStale(now) -> "Cache stale · not synced"
        photosWaiting > 0 && health == "synced" -> "Visits synced · photos uploading"
        health == "synced" && lastSuccess != null -> "All synced"
        else -> "Sync pending"
    }

    companion object {
        fun fromRoom(partition: PartitionRow?, rows: List<OutboxRow>, offline: Boolean = false,
            intents: List<IntentRow> = emptyList()): SyncStatus {
            val current = rows.filter { it.scope == partition?.scope }
            val held = rows.count { it.scope != partition?.scope && it.state != "done" } +
                if (partition?.held == true) current.count { it.state != "done" } else 0
            val active = if (partition?.held == true) emptyList() else current
            val byRequest = intents.associateBy { it.requestId }
            val starts = intents.filter { it.kind == "visit.checkIn" }.associateBy { it.clientVisitId }
            val earliestClose = active.filter { it.state in setOf("pending", "sending") }.minOfOrNull { row ->
                val intent = byRequest[row.requestId]
                val start = intent?.let { starts[it.clientVisitId] }
                val day = start?.let { runCatching { JSONObject(it.serializedOperation).getJSONObject("payload")
                    .getString("serviceDate") }.getOrNull() }
                day?.let { runCatching { dayClose(it) }.getOrNull() } ?: dayCloseFor(row.createdAt)
            }
            return SyncStatus(active.count { it.state == "pending" }, active.count { it.state == "sending" },
                active.count { it.state == "review" }, held, partition?.lastSuccessfulSync,
                partition?.leaseExpiresAt, partition?.cacheExpiresAt, partition?.syncHealth ?: "never_synced",
                offline, rows.filter { it.state == "review" }.map { plainReason(it.rejectionCode) }, earliestClose)
        }

        /** Never render a server-supplied free-form rejection or payload. */
        fun plainReason(code: String?): String = when (code) {
            "call_open" -> "Finish the open call first"
            "mcp_order" -> "Visit stores in plan order"
            "wrong_date" -> "Visit date does not match the phone date"
            "dependency_missing" -> "Check-in was not accepted; dependent visit needs review"
            "rebootstrap_visit_changed" -> "Visit changed since it was queued"
            "conflict" -> "Server reported a conflict"
            "rejected" -> "Server rejected this visit"
            else -> "Visit needs administrator review"
        }
    }
}
