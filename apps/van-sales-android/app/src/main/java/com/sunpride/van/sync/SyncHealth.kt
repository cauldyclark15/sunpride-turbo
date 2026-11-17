package com.sunpride.van.sync

import com.sunpride.van.data.SyncStatus
import org.json.JSONObject

/**
 * VAN-025: three separate answers for every piece of work saved on this phone, so a seller can tell what is only
 * safe on the phone from what the office has and from what is posted to SAP.
 *
 * 1. Phone: everything here is already committed to the encrypted store (saving never needs signal).
 * 2. Office server: derived only from the outbox row status, never from a network reply.
 * 3. SAP: van SAP posting is not switched on in this phase (no SAP status reaches the handheld), so every
 *    SAP-relevant document honestly reads "not posted to SAP"; nothing here ever claims a posting.
 */
enum class OfficeState(val label: String) {
    /** Kept on the phone; the office upload for this kind is not available yet (parked outbox row). */
    PHONE_ONLY("Saved on this phone — office upload not available yet"),
    WAITING("Waiting to send to the office"),
    SENDING("Sending to the office"),
    /** Signed-in account or phone needs checking; the work stays on the phone and counts as waiting to send. */
    PAUSED("Waiting to send"),
    RECEIVED("Sent"),
    /**
     * SP-0190: the office answered for good and (with `kept`) holds its own copy. The seller never sees this as a
     * problem: it is not listed and not counted; the office finishes it.
     */
    WITH_OFFICE("Sent"),
}

/** SP-0190: the only three things a seller is ever told about sending. */
enum class SimpleSync(val label: String) { ALL_SENT("All sent"), WAITING("Waiting to send"), NO_SIGNAL("Waiting for signal") }

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
    val SAP_KINDS = setOf("sale.record", "sale.void", "return.record", "refund.record", "cash.reconcile", "load.confirm", "truck.damage")

    fun title(kind: String): String = when (kind) {
        "sale.record" -> "Sale"
        "sale.void" -> "Cancelled sale"
        "return.record" -> "Customer return"
        "refund.record", "store.refund.part" -> "Item refund"
        "stock.reconcile" -> "Stock count"
        "trip.close" -> "Trip close"
        "cash.reconcile" -> "Cash count"
        "load.confirm" -> "Load check"
        "trip.start" -> "Trip start"
        "truck.damage" -> "Truck damage"
        "load.accept" -> "Load count"
        "crew.switch" -> "Crew change"
        "store.cash" -> "Cash movement"
        "store.read" -> "X / Z reading"
        else -> "Other work"
    }

    fun office(status: String, held: Boolean): OfficeState = when (status) {
        "parked" -> OfficeState.PHONE_ONLY
        "done" -> OfficeState.RECEIVED
        "rejected", "conflict", com.sunpride.van.storage.OutboxRules.OFFICE -> OfficeState.WITH_OFFICE
        "sending" -> if (held) OfficeState.PAUSED else OfficeState.SENDING
        else -> if (held) OfficeState.PAUSED else OfficeState.WAITING
    }

    fun sap(kind: String): SapState = if (kind in SAP_KINDS) SapState.NOT_POSTED else SapState.NOT_NEEDED

    private fun reference(json: String): String? = try {
        val p = JSONObject(json).optJSONObject("payload")
        p?.optString("receiptNumber")?.takeIf { it.isNotBlank() } ?: p?.optString("returnNumber")?.takeIf { it.isNotBlank() }
            ?: p?.optString("creditNumber")?.takeIf { it.isNotBlank() }
    } catch (_: Exception) { null }

    /** Newest first; ties broken by request id so the list never reorders between refreshes. */
    fun items(rows: List<OutboxFacts>, held: Boolean, limit: Int = MAX_ITEMS): List<SyncItem> = rows
        .sortedWith(compareByDescending<OutboxFacts> { it.createdAt }.thenBy { it.clientRequestId }).take(limit)
        .map { SyncItem(it.clientRequestId, it.kind, title(it.kind), reference(it.operationJson), it.createdAt,
            office(it.status, held), sap(it.kind), it.rejectionCode) }

    /** Work not yet held by the office: phone-only, waiting, sending and paused. */
    fun onPhoneOnly(s: SyncStatus): Int = s.phoneOnly + s.queued + s.sending + s.held

    /** SP-0190: everything not yet with the office (parked, waiting, sending, held under an earlier sign-in). */
    fun waiting(s: SyncStatus): Int = onPhoneOnly(s)

    /** All sent / Waiting to send / Waiting for signal. Refused work is never part of this answer. */
    fun simple(s: SyncStatus): SimpleSync = when {
        waiting(s) == 0 -> SimpleSync.ALL_SENT
        s.health == "retry_pending" -> SimpleSync.NO_SIGNAL
        else -> SimpleSync.WAITING
    }

    /** The one line a seller reads: "All sent", "Waiting to send (3)" or "Waiting for signal (3)". */
    fun line(s: SyncStatus): String = simple(s).let { if (it == SimpleSync.ALL_SENT) it.label else "${it.label} (${waiting(s)})" }

    /** The Today footer: the same one line plus when work was last sent. */
    fun footer(s: SyncStatus, lastSync: String): String = "${line(s)}\nLast sent: $lastSync"

    /** VAN-086: health recorded when the office paused this phone (device suspended); cleared by the next good sync. */
    const val PAUSED_HEALTH = "paused"
    const val PAUSED_LABEL = "Sync is paused: the office paused this phone. Your work stays here and is sent when the office turns the phone back on."

    /** Extra words only when the seller can act on them; otherwise null (the three states say it all). */
    fun healthLabel(health: String): String? = when (health) {
        PAUSED_HEALTH -> PAUSED_LABEL
        "update_required" -> "Update the app to send your work"
        else -> null
    }
}
