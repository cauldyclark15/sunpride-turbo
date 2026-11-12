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
    val photosWaiting: Int = 0,
    /** FLD-153: plain words for each kind of held work, so "Held · needs review" always explains itself. */
    val heldReasons: List<String> = emptyList(),
    /** FLD-176: each refused item the person can read and clear on the phone (never server text). */
    val reviewItems: List<ReviewItem> = emptyList(),
) {
    /** One refused item: what it was, the plain reason, and the id used to clear it from this phone. */
    data class ReviewItem(val requestId: String, val what: String, val reason: String)
    val pending get() = queued + sending + review + held > 0
    /** FLD-147: the Sync screen counts the same photos the pill does, so they never disagree. */
    val nothingWaiting get() = queued == 0 && sending == 0 && photosWaiting == 0
    fun leaseExpired(now: Long) = leaseExpiresAt == null || now >= leaseExpiresAt
    fun cacheStale(now: Long) = cacheExpiresAt == null || now >= cacheExpiresAt
    fun label(now: Long): String = when {
        held > 0 || health == "held_for_review" -> "Held · needs review"
        // FLD-176: a refused item is not unsent work. Only say "not synced" when something still waits to go.
        review > 0 -> if (queued > 0 || sending > 0) "Needs review · not synced" else "Needs review"
        queued > 0 || sending > 0 -> if (now >= (earliestUnsentCloseAt ?: dayCloseFor(now)))
            "Late · held for review" else if (offline) "Offline · sync before 10 PM" else "Sync before 10 PM"
        offline -> "Offline · saved data"
        leaseExpired(now) -> "Day closed · sync for access"
        cacheStale(now) -> "Cache stale · not synced"
        photosWaiting > 0 && health == "synced" -> "Visits synced · photos uploading"
        health == "synced" && lastSuccess != null -> "All synced"
        else -> "Sync pending"
    }

    companion object {
        fun fromRoom(partition: PartitionRow?, rows: List<OutboxRow>, offline: Boolean = false,
            intents: List<IntentRow> = emptyList(), dismissed: Set<String> = emptySet()): SyncStatus {
            val current = rows.filter { it.scope == partition?.scope }
            val earlier = rows.count { it.scope != partition?.scope && it.state != "done" }
            val heldHere = if (partition?.held == true) current.count { it.state != "done" } else 0
            val held = earlier + heldHere
            val heldReasons = listOfNotNull(
                HELD_EARLIER.takeIf { earlier > 0 },
                HELD_ACCESS.takeIf { heldHere > 0 || (partition?.held == true && held == 0) },
            )
            // FLD-176: a refused item the person has read and cleared no longer counts or shows; nothing
            // was accepted by the server for it, so there is no work left to send.
            val active = (if (partition?.held == true) emptyList() else current)
                .filterNot { it.state == "review" && it.requestId in dismissed }
            val byRequest = intents.associateBy { it.requestId }
            val reviewItems = active.filter { it.state == "review" }.map {
                ReviewItem(it.requestId, describe(byRequest[it.requestId]?.kind), plainReason(it.rejectionCode))
            }
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
                offline, reviewItems.map { it.reason }, earliestClose,
                heldReasons = heldReasons, reviewItems = reviewItems)
        }

        const val HELD_EARLIER = "Saved under an earlier sign-in or work area. It stays on this phone and is not sent. Ask your supervisor before clearing this phone."
        const val HELD_ACCESS = "Your access is being checked. Work stays on this phone and is sent once the office confirms it."

        /** Plain name of the refused item's kind. */
        fun describe(kind: String?): String = when (kind) {
            "visit.checkIn" -> "Start visit"
            "visit.checkOut" -> "End visit"
            "visit.activity", "dsr.visit.activity" -> "Visit task"
            "dsr.visit.checkIn" -> "Start visit"
            "dsr.visit.checkOut" -> "End visit"
            "availability.record", "dsr.availability.record" -> "Shelf check"
            "collections.capture" -> "Collection"
            "jointcall.capture" -> "Work-With"
            "workforce.clockIn" -> "Clock in"
            "workforce.clockOut" -> "Clock out"
            "workforce.prospect" -> "New prospect"
            "outlet.census", "outlet.change" -> "Store change"
            "order_intent", "order.intent" -> "Order"
            else -> "Saved work"
        }

        /**
         * FLD-153: plain words for EVERY refusal code the field sync can record: the server's closed per-op
         * codes (apps/api/src/core/sync.js OP_CODES, plus the v1 `reason` codes), the v1 result statuses
         * used as a fallback code, and the codes the phone itself records. SyncStatusTest reads OP_CODES
         * from the API source and fails if any code has no wording here.
         * Never render a server-supplied free-form rejection or payload.
         */
        val REASONS: Map<String, String> = linkedMapOf(
            // Server per-op codes (OP_CODES).
            "invalid_request" to "The phone sent something the office system could not read. Ask your supervisor",
            "invalid_plan" to "This visit was changed or closed by the office (for example marked missed)",
            "out_of_scope" to "This store or work is no longer assigned to you",
            "dependency_missing" to "Check-in was not accepted; dependent visit needs review",
            "invalid_transition" to "This visit was already ended or changed, so this step was not accepted",
            "call_open" to "Finish the open call first",
            "mcp_order" to "Visit customers in plan order",
            "wrong_date" to "Visit date does not match the phone date",
            "idempotency_conflict" to "This was already recorded once, so the second copy was not accepted",
            "evidence_pending_review" to "A photo for this visit is waiting for office review",
            "unsupported_operation" to "This app version cannot send this. Update the app",
            "load_not_posted" to "The truck load is not posted yet",
            "stock_conflict" to "Stock changed in the office. Refresh and try again",
            "mock_location_refused" to "Location looked faked, so this was not accepted",
            "place_mismatch" to "You were not at this store's location",
            "places_unavailable" to "The store's location could not be checked. Ask your supervisor",
            // v1 result statuses used when no code came back.
            "conflict" to "Server reported a conflict",
            "rejected" to "Server rejected this visit",
            "unsupported" to "This app version cannot send this. Update the app",
            "review_required" to "The office needs to review this",
            "unknown_status" to "The office system gave no clear answer. Ask your supervisor",
            // Domain-form refusals that also hold the phone for review (DomainOutbox).
            "scope_changed" to "Your work area changed. Sync again",
            "device_revoked" to "This phone was removed by the office",
            "unauthorized" to "Your access could not be confirmed. Sign in again",
            // Codes the phone records itself.
            "rebootstrap_visit_changed" to "Visit changed since it was queued",
            "photo_needs_review" to "The visit photo needs review, so this was not sent",
        )

        fun plainReason(code: String?): String = REASONS[code] ?: "Visit needs administrator review"
    }
}
