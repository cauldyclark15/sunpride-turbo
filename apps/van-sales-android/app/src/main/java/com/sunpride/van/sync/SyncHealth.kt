package com.sunpride.van.sync

import com.sunpride.van.data.SyncStatus
import org.json.JSONObject

/**
 * VAN-025: three separate answers for every piece of work saved on this phone, so a seller can tell what is only
 * safe on the phone from what the office has and from what is posted to SAP.
 *
 * 1. Phone: everything here is already committed to the encrypted store (saving never needs signal).
 * 2. Office (Convex): derived only from the outbox row status, never from a network reply.
 * 3. SAP: van SAP posting is not switched on in this phase (no SAP status reaches the handheld), so every
 *    SAP-relevant document honestly reads "not posted to SAP"; nothing here ever claims a posting.
 */
enum class OfficeState(val label: String) {
    /** Kept on the phone; the office upload for this kind is not available yet (parked outbox row). */
    PHONE_ONLY("Saved on this phone — office upload not available yet"),
    WAITING("Waiting to send to the office"),
    SENDING("Sending to the office"),
    /** Signed-in account or phone needs checking; the work stays on the phone until resolved. */
    PAUSED("Paused — kept on this phone, ask your supervisor"),
    RECEIVED("Received by the office"),
    NEEDS_REVIEW("Office could not accept it — needs review"),
}

enum class SapState(val label: String) {
    NOT_POSTED("Not posted to SAP yet"),
    NOT_NEEDED("No SAP posting needed"),
}

/** The outbox facts the health view needs; [operationJson] is read only for a receipt/return number. */
data class OutboxFacts(val clientRequestId: String, val kind: String, val status: String, val createdAt: Long,
    val operationJson: String, val rejectionCode: String? = null)

data class SyncItem(val clientRequestId: String, val kind: String, val title: String, val reference: String?,
    val createdAt: Long, val office: OfficeState, val sap: SapState, val rejectionCode: String?)

object SyncHealth {
    /** Most recent items listed on the status screen; the counts always cover every row. */
    const val MAX_ITEMS = 50
    /** Van kinds that become an SAP document or stock/cash posting once van SAP posting is switched on. */
    val SAP_KINDS = setOf("sale.record", "sale.void", "return.record", "cash.reconcile", "load.confirm", "truck.damage")

    fun title(kind: String): String = when (kind) {
        "sale.record" -> "Sale"
        "sale.void" -> "Cancelled sale"
        "return.record" -> "Customer return"
        "cash.reconcile" -> "Cash count"
        "load.confirm" -> "Load check"
        "trip.start" -> "Trip start"
        "truck.damage" -> "Truck damage"
        else -> "Other work"
    }

    fun office(status: String, held: Boolean): OfficeState = when (status) {
        "parked" -> OfficeState.PHONE_ONLY
        "done" -> OfficeState.RECEIVED
        "rejected", "conflict" -> OfficeState.NEEDS_REVIEW
        "sending" -> if (held) OfficeState.PAUSED else OfficeState.SENDING
        else -> if (held) OfficeState.PAUSED else OfficeState.WAITING
    }

    fun sap(kind: String): SapState = if (kind in SAP_KINDS) SapState.NOT_POSTED else SapState.NOT_NEEDED

    private fun reference(json: String): String? = try {
        val p = JSONObject(json).optJSONObject("payload")
        p?.optString("receiptNumber")?.takeIf { it.isNotBlank() } ?: p?.optString("returnNumber")?.takeIf { it.isNotBlank() }
    } catch (_: Exception) { null }

    /** Newest first; ties broken by request id so the list never reorders between refreshes. */
    fun items(rows: List<OutboxFacts>, held: Boolean, limit: Int = MAX_ITEMS): List<SyncItem> = rows
        .sortedWith(compareByDescending<OutboxFacts> { it.createdAt }.thenBy { it.clientRequestId }).take(limit)
        .map { SyncItem(it.clientRequestId, it.kind, title(it.kind), reference(it.operationJson), it.createdAt,
            office(it.status, held), sap(it.kind), it.rejectionCode) }

    /** Work not yet held by the office: phone-only, waiting, sending and paused. */
    fun onPhoneOnly(s: SyncStatus): Int = s.phoneOnly + s.queued + s.sending + s.held

    private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"

    fun phoneLine(s: SyncStatus): String {
        val n = onPhoneOnly(s)
        return if (n == 0) "Phone: nothing waiting — all work is with the office"
        else "Phone: ${plural(n, "item", "items")} kept only on this phone"
    }

    fun officeLine(s: SyncStatus, lastSync: String): String =
        "Office: ${s.received} received · ${s.queued + s.sending} waiting · ${s.review} to review" +
            (if (s.held > 0) " · ${s.held} paused" else "") + "\nLast sync: $lastSync"

    fun sapLine(s: SyncStatus): String =
        if (s.sapPending == 0) "SAP: nothing to post yet" else "SAP: ${s.sapPending} not posted yet"

    /** The Today footer: phone, office and SAP on separate lines, short enough for the 720×1440 handheld. */
    fun footer(s: SyncStatus, lastSync: String): String = listOfNotNull(
        phoneLine(s),
        s.savedSales.takeIf { it > 0 }?.let { "${plural(it, "sale", "sales")} saved on this phone" },
        s.savedReturns.takeIf { it > 0 }?.let { "${plural(it, "return", "returns")} saved on this phone" },
        officeLine(s, lastSync),
        sapLine(s),
    ).joinToString("\n")

    /** Health code → plain words for the status screen. Unknown codes never echo raw text. */
    fun healthLabel(health: String): String = when (health) {
        "synced" -> "Last sync finished"
        "retry_pending" -> "Last sync did not finish — it will try again"
        "held_for_review" -> "Sync paused — ask your supervisor"
        "update_required" -> "Update the app to sync"
        "bootstrap_ready" -> "Trip downloaded"
        "never_synced" -> "Not synced yet"
        else -> "Sync state unknown"
    }
}
