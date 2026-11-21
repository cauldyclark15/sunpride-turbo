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

/**
 * A local Room projection only. Connectivity affects the label, never the durable counts.
 * SP-0189: a salesman only ever sees three states: "All sent", "Waiting to send (N)" and "Waiting for signal".
 * Saves the server refused ([review], internal only) are never listed or counted as waiting; saves the server kept
 * for the office (outbox state `office`) are not counted at all.
 */
data class SyncStatus(
    val queued: Int = 0, val sending: Int = 0, val review: Int = 0, val held: Int = 0,
    val lastSuccess: Long? = null, val leaseExpiresAt: Long? = null,
    val cacheExpiresAt: Long? = null, val health: String = "never_synced",
    val offline: Boolean = false,
    val earliestUnsentCloseAt: Long? = null,
    /** AND-016 photos saved on the phone and not yet uploaded. Never blocks visit sync or End. */
    val photosWaiting: Int = 0,
    /** FLD-153: internal reasons for held work (SyncWork reads them); never shown to the salesman. */
    val heldReasons: List<String> = emptyList(),
    /** Saves the server did not accept (recent, not cleared): shown plainly so "All sent" is never a lie. */
    val notAccepted: List<NotAccepted> = emptyList(),
) {
    /** One save the server did not accept, with the plain reason shown to the salesman. */
    data class NotAccepted(val requestId: String, val kind: String?, val code: String?, val at: Long) {
        val title get() = describe(kind)
        val text get() = notAcceptedText(code)
    }
    /** Work still on this phone that will be sent: queued, sending, held under an earlier sign-in, photos. */
    val waiting get() = queued + sending + held + photosWaiting
    val pending get() = queued + sending + held > 0
    /** FLD-147: the Sync screen counts the same photos the pill does, so they never disagree. */
    val nothingWaiting get() = waiting == 0
    fun leaseExpired(now: Long) = leaseExpiresAt == null || now >= leaseExpiresAt
    fun cacheStale(now: Long) = cacheExpiresAt == null || now >= cacheExpiresAt
    @Suppress("UNUSED_PARAMETER")
    fun label(now: Long): String = when {
        waiting > 0 && offline -> WAITING_FOR_SIGNAL
        waiting > 0 -> waitingToSend(waiting)
        notAccepted.isNotEmpty() -> notAcceptedCount(notAccepted.size)
        else -> ALL_SENT
    }

    companion object {
        const val ALL_SENT = "All sent"
        const val WAITING_FOR_SIGNAL = "Waiting for signal"
        fun waitingToSend(n: Int) = "Waiting to send ($n)"
        fun notAcceptedCount(n: Int) = "Not accepted ($n)"
        /** How long a not-accepted save stays on the Sync page. */
        const val NOT_ACCEPTED_DAYS = 3L
        /**
         * The one state label for a saved item on every salesman screen (visit, call sheet, history, workforce):
         * a save the server did not accept is never shown as "Saved" or "Sent".
         */
        fun itemState(state: String, code: String? = null): String = when {
            state == "pending" || state == "sending" -> "Waiting to send"
            state == "done" -> "Sent"
            com.sunpride.field.storage.OutboxState.refused(state) -> notAcceptedText(code)
            else -> "Saved on this phone"
        }
        fun notAcceptedText(code: String?) = "Not accepted: ${salesmanReason(code)}"
        /** Plain, salesman-facing reason for a refusal code. */
        fun salesmanReason(code: String?): String = when (code) {
            "invalid_plan" -> "this visit was changed or closed by the office (for example marked missed)"
            "out_of_scope", "scope_changed" -> "this store or work is no longer assigned to you"
            "dependency_missing" -> "the visit start was not accepted, so this step was not either"
            "invalid_transition" -> "this visit was already ended or changed"
            "call_open" -> "finish the open call first"
            "mcp_order" -> "visit customers in plan order"
            "wrong_date" -> "the visit date does not match the phone date"
            "idempotency_conflict" -> "this was already recorded once"
            "evidence_pending_review", "photo_needs_review" -> "a photo for this visit is still being checked"
            "unsupported_operation", "unsupported" -> "this app version cannot send this. Update the app"
            "load_not_posted" -> "the truck load is not posted yet"
            "stock_conflict" -> "stock changed in the office. Refresh and try again"
            "mock_location_refused" -> "the location looked faked"
            "place_mismatch" -> "you were not at this store's location"
            "rebootstrap_visit_changed" -> "the visit changed after you saved this"
            "work_with_incomplete" -> "the joint call is missing a required part"
            "device_revoked" -> "this phone was removed by the office"
            "unauthorized" -> "your access could not be confirmed. Sign in again"
            else -> "the office did not take this. Call your team lead"
        }
        /** Recent saves the server did not accept, newest first, from the phone's outbox. */
        fun notAcceptedFrom(history: List<Pair<IntentRow, OutboxRow>>, dismissed: Set<String>, now: Long): List<NotAccepted> =
            history.filter { (_, row) -> com.sunpride.field.storage.OutboxState.refused(row.state) && row.requestId !in dismissed &&
                row.createdAt >= now - NOT_ACCEPTED_DAYS * 86_400_000L }
                .map { (intent, row) -> NotAccepted(row.requestId, intent.kind, row.rejectionCode, row.createdAt) }
                .sortedByDescending { it.at }
        /** Every word a salesman may see on the Sync page and pill (SP-0189). "Not accepted" is allowed: a refused
         * save must say so plainly. */
        val FORBIDDEN_WORDS = listOf("review", "reconcil", "rejected", "refused", "invalid",
            "supervisor", "office system", "conflict", "remove from this phone")
        fun fromRoom(partition: PartitionRow?, rows: List<OutboxRow>, offline: Boolean = false,
            intents: List<IntentRow> = emptyList(), @Suppress("UNUSED_PARAMETER") dismissed: Set<String> = emptySet()): SyncStatus {
            val current = rows.filter { it.scope == partition?.scope && it.state != com.sunpride.field.storage.OutboxState.OFFICE }
            val earlier = rows.count { it.scope != partition?.scope && it.state in setOf("pending", "sending") }
            val heldHere = if (partition?.held == true) current.count { it.state in setOf("pending", "sending") } else 0
            val held = earlier + heldHere
            val heldReasons = listOfNotNull(
                HELD_EARLIER.takeIf { earlier > 0 },
                HELD_ACCESS.takeIf { heldHere > 0 || (partition?.held == true && held == 0) },
            )
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
                active.count { it.state == com.sunpride.field.storage.OutboxState.REVIEW }, held, partition?.lastSuccessfulSync,
                partition?.leaseExpiresAt, partition?.cacheExpiresAt, partition?.syncHealth ?: "never_synced",
                offline, earliestClose, heldReasons = heldReasons)
        }

        /** Internal markers only (SyncWork reads them); the salesman just sees "Waiting to send". */
        const val HELD_EARLIER = "held:earlier_sign_in"
        const val HELD_ACCESS = "held:access_check"

        /** Plain name of a saved item's kind (internal/diagnostic use; the office list uses the same words). */
        fun describe(kind: String?): String = when (kind) {
            "visit.checkIn" -> "Start visit"
            "visit.checkOut" -> "End visit"
            "visit.activity", "dsr.visit.activity" -> "Visit task"
            "dsr.visit.checkIn" -> "Start visit"
            "dsr.visit.checkOut" -> "End visit"
            "availability.record", "dsr.availability.record" -> "Shelf check"
            "collections.capture" -> "Collection"
            "remittance.submit" -> "Cash remittance"
            "truckweek.capture" -> "Truck stock count"
            "jointcall.capture" -> "Work-With"
            "workforce.clockIn" -> "Clock in"
            "workforce.clockOut" -> "Clock out"
            "workforce.prospect" -> "Prospect"
            "outlet.census", "outlet.change" -> "Store change"
            "order_intent", "order.intent" -> "Order"
            "census.capture" -> "New customer"
            else -> "Saved work"
        }

        /**
         * Internal/diagnostic only since SP-0189: never shown on a salesman screen.
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
            "work_with_incomplete" to "The joint call is missing a required part. Open it, fill in what it lists and Save and finish again",
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
        /** Internal/diagnostic wording for a refusal code; never shown to the salesman. */
        fun plainReason(code: String?): String = REASONS[code] ?: "Visit needs administrator review"

    }
}
