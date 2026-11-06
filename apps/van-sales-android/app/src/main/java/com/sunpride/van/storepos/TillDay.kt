package com.sunpride.van.storepos

import com.sunpride.van.printing.PesoAmounts
import com.sunpride.van.printing.ReceiptAlignment
import com.sunpride.van.printing.ReceiptDocument
import com.sunpride.van.printing.ReceiptElement
import com.sunpride.van.printing.ReceiptStyle
import com.sunpride.van.storage.OutboxRow
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * IP-HH2: the store till day on the phone: cash movements with their reason codes, the supervisors who can approve at this
 * register, the server's list of recent sessions, and the X / Z reading printed from what this phone holds.
 */
enum class CashKind(val wire: String, val label: String, val supervisor: Boolean, val overrideKind: String?, val hasAmount: Boolean, val help: String) {
    DROP("drop", "Cash drop", true, "cash_drop", true, "Move cash from the drawer to the safe."),
    PICKUP("pickup", "Cash pickup", true, "cash_pickup", true, "Cash taken out of the drawer for the bank or the owner."),
    PAID_OUT("paid_out", "Paid out", true, "paid_out", true, "Cash paid from the drawer for an expense."),
    PAID_IN("paid_in", "Paid in", false, null, true, "Cash put into the drawer that is not a sale."),
    NO_SALE("no_sale", "No sale", true, "no_sale", false, "Open the drawer without a sale. Nothing is counted.");
    companion object { fun of(wire: String?) = entries.firstOrNull { it.wire == wire } }
}

data class CashReason(val code: String, val label: String, val noteRequired: Boolean = false)

object CashReasons {
    /** The office's till reasons as they were seeded (migration 0760). A newer bundle can send its own list under `cashReasons`; this is the fallback. */
    private val defaults: Map<CashKind, List<CashReason>> = mapOf(
        CashKind.DROP to listOf(CashReason("till_limit", "Too much cash in the drawer"), CashReason("safe_drop", "Move to the safe"), CashReason("end_of_day", "End of day drop")),
        CashKind.PICKUP to listOf(CashReason("bank_deposit", "For the bank"), CashReason("owner_pickup", "Picked up by the owner or supervisor")),
        CashKind.PAID_OUT to listOf(CashReason("supplies", "Store supplies"), CashReason("delivery_fee", "Delivery fee"), CashReason("petty_cash", "Petty cash"), CashReason("other", "Other (write why)", true)),
        CashKind.PAID_IN to listOf(CashReason("change_fund", "Change fund returned"), CashReason("correction", "Correction"), CashReason("other", "Other (write why)", true)),
        CashKind.NO_SALE to listOf(CashReason("change_request", "Customer needs change"), CashReason("drawer_check", "Checking the drawer"), CashReason("other", "Other (write why)", true)),
    )
    fun forKind(kind: CashKind, details: JSONObject? = null): List<CashReason> {
        val sent = details?.optJSONObject("cashReasons")?.optJSONArray(kind.wire)
        val fromBundle = sent?.let { a -> (0 until a.length()).mapNotNull { a.optJSONObject(it) }.mapNotNull { o ->
            val code = o.optString("code").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            CashReason(code, o.optString("label").ifBlank { code }, o.optBoolean("note") || o.optBoolean("noteRequired"))
        } }.orEmpty()
        return fromBundle.ifEmpty { defaults.getValue(kind) }
    }
}

data class Supervisor(val profileId: String, val name: String, val pinId: String, val salt: String, val hash: String)

object Supervisors {
    /** Supervisors downloaded for this register; the cashier themself is never offered (the server refuses a self-approval). */
    fun of(details: JSONObject?, cashierProfileId: String?): List<Supervisor> {
        val a = details?.optJSONArray("supervisors") ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }.mapNotNull { o ->
            runCatching { Supervisor(o.getString("profileId"), o.getString("name"), o.getString("pinId"), o.getString("salt"), o.getString("hash")) }.getOrNull()
        }.filter { it.profileId != cashierProfileId }
    }
    fun json(s: Supervisor, proof: String): JSONObject = JSONObject().put("profileId", s.profileId).put("pinId", s.pinId).put("method", "pin_offline").put("proof", proof)
}

object TillPayloads {
    const val MAX_CENTAVOS = 9_000_000_000L
    /** `store.cash` payload (the shift, register and time are added when it is queued). A supervisor goes in later, once the PIN is checked. */
    fun cash(kind: CashKind, amountCentavos: Long, reasonCode: String, note: String?): JSONObject {
        require(!kind.hasAmount && amountCentavos == 0L || kind.hasAmount && amountCentavos in 1..MAX_CENTAVOS)
        return JSONObject().put("kind", kind.wire).put("reasonCode", reasonCode)
            .apply { if (kind.hasAmount) put("amountCentavos", amountCentavos.toString()) }
            .apply { note?.trim()?.takeIf { it.isNotEmpty() }?.let { put("note", it.take(300)) } }
    }
    /** What the cashier still has to supply before the movement can be saved (plain words), or null. */
    fun problem(kind: CashKind, amountCentavos: Long?, reason: CashReason?, note: String): String? = when {
        kind.hasAmount && (amountCentavos == null || amountCentavos <= 0L) -> "Enter the amount."
        kind.hasAmount && amountCentavos!! > MAX_CENTAVOS -> "That amount is too large."
        reason == null -> "Choose why."
        reason.noteRequired && note.trim().length < 3 -> "Write why in a few words."
        else -> null
    }
}

/** One cashier session as the office holds it (the phone shows these, it does not rebuild them from its outbox). */
data class TillSession(val shiftId: String, val number: String?, val businessDate: String?, val openedAt: Long, val closedAt: Long?, val status: String, val dayStatus: String?) {
    val forceClosed: Boolean get() = status == "force_closed"
    /** Plain words. A force-closed session says so and that nobody counted the cash. */
    val statusLabel: String get() = when (status) {
        "open" -> "Open"; "suspended" -> "Paused"; "closed" -> "Closed"
        "force_closed" -> "Closed by a supervisor. The cash was not counted by you."
        else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
    val dayLabel: String? get() = when (dayStatus) { "z_done" -> "Z reading done"; "closing" -> "Day is closing"; "open" -> null; else -> null }
}

object TillSessions {
    fun of(details: JSONObject?): List<TillSession> {
        val a = details?.optJSONArray("sessions") ?: return emptyList()
        return (0 until a.length()).mapNotNull { a.optJSONObject(it) }.mapNotNull { o ->
            runCatching { TillSession(o.getString("shiftId"), o.optString("number").takeIf { it.isNotBlank() && !o.isNull("number") }, o.optString("businessDate").takeIf { it.isNotBlank() && !o.isNull("businessDate") },
                o.getLong("openedAt"), if (o.isNull("closedAt")) null else o.getLong("closedAt"), o.getString("status"), o.optString("dayStatus").takeIf { it.isNotBlank() && !o.isNull("dayStatus") }) }.getOrNull()
        }
    }
    /** Z is for the end of the day: every session closed (the server checks the same), none open here. */
    fun zReady(sessions: List<TillSession>, shiftOpenHere: Boolean): Boolean = !shiftOpenHere && sessions.none { it.status == "open" || it.status == "suspended" } && sessions.isNotEmpty()
    fun zProblem(sessions: List<TillSession>, shiftOpenHere: Boolean): String? = when {
        shiftOpenHere -> "End your cashier session first (blind cash count). Z comes after every session is closed."
        sessions.any { it.status == "open" || it.status == "suspended" } -> "Another cashier session is still open on this register. Z comes after every session is closed."
        sessions.isEmpty() -> "No cashier session on this phone yet. Sync to get the register's sessions."
        sessions.all { it.dayStatus == "z_done" } && sessions.isNotEmpty() -> "Z is already done for this day."
        else -> null
    }
}

/** Totals for an X or Z reading from the receipts on this phone (voided receipts left out). Blind: never any expected cash. */
data class ReadingTotals(val receipts: Int, val grossMinor: Long, val voids: Int, val voidMinor: Long, val tenders: Map<String, Long>,
    val vatableMinor: Long, val vatMinor: Long, val exemptMinor: Long, val zeroMinor: Long, val discounts: Map<String, Pair<Long, Long>>)

object Readings {
    private val manila = ZoneId.of("Asia/Manila")
    private val time = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    private fun m(o: JSONObject, k: String): Long = o.optString(k, "0").toLongOrNull() ?: 0L

    fun totals(receipts: List<JSONObject>): ReadingTotals {
        var gross = 0L; var n = 0; var voids = 0; var voidMinor = 0L; var vatable = 0L; var vat = 0L; var exempt = 0L; var zero = 0L
        val tenders = linkedMapOf<String, Long>(); val discounts = linkedMapOf<String, Pair<Long, Long>>()
        receipts.forEach { r ->
            val total = m(r, "totalMinor")
            if (r.optString("_status") == "voided") { voids++; voidMinor += total; return@forEach }
            n++; gross += total
            r.optJSONArray("tenders")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.forEach { t ->
                val label = t.optString("label").ifBlank { t.optString("method") }
                tenders[label] = (tenders[label] ?: 0L) + m(t, "amountCentavos")
            } }
            r.optJSONObject("tax")?.let { t -> vatable += m(t, "vatableSalesMinor"); vat += m(t, "vatMinor"); exempt += m(t, "vatExemptMinor"); zero += m(t, "zeroRatedMinor") }
            r.optJSONObject("privilege")?.optJSONObject("byType")?.let { by -> by.keys().forEach { type ->
                val v = by.getJSONObject(type); val old = discounts[type] ?: (0L to 0L)
                discounts[type] = (old.first + m(v, "discountMinor")) to (old.second + m(v, "vatRemovedMinor"))
            } }
        }
        return ReadingTotals(n, gross, voids, voidMinor, tenders, vatable, vat, exempt, zero, discounts)
    }

    /** Cash movements queued on this phone, newest data only: per kind (count, amount). */
    fun movements(rows: List<OutboxRow>, shiftId: String? = null): Map<CashKind, Pair<Int, Long>> {
        val out = linkedMapOf<CashKind, Pair<Int, Long>>()
        rows.filter { it.kind == "store.cash" && it.status !in setOf("rejected", "conflict", "parked") }.forEach { row ->
            val p = JSONObject(row.operationJson).getJSONObject("payload")
            if (shiftId != null && p.optString("shiftId") != shiftId) return@forEach
            val kind = CashKind.of(p.optString("kind")) ?: return@forEach
            val old = out[kind] ?: (0 to 0L)
            out[kind] = (old.first + 1) to (old.second + (p.optString("amountCentavos", "0").toLongOrNull() ?: 0L))
        }
        return out
    }

    private fun peso(n: Long) = PesoAmounts.fromCentavos(n)
    private fun type(code: String) = com.sunpride.van.selling.PrivilegeType.of(code)?.label ?: code

    /**
     * The reading as the printer takes it (the same lines the office's print model has: title, document number, rows, footer). [kind] is
     * "X" (any time, no stop) or "Z" (end of day). Nothing here is an expected cash figure.
     */
    fun document(kind: String, store: String?, register: String?, terminal: String?, cashier: String?, now: Long, totals: ReadingTotals,
        movements: Map<CashKind, Pair<Int, Long>>, sessions: List<TillSession> = emptyList(), docNumber: String? = null): ReceiptDocument {
        val at = Instant.ofEpochMilli(now).atZone(manila).format(time)
        val e = mutableListOf<ReceiptElement>()
        fun text(s: String, bold: Boolean = false, center: Boolean = false) { e += ReceiptElement.Text(s, ReceiptStyle(if (center) ReceiptAlignment.CENTER else ReceiptAlignment.LEFT, bold = bold)) }
        fun row(l: String, v: String, bold: Boolean = false) { e += ReceiptElement.Columns(l, v, bold) }
        text(store ?: "SUNPRIDE STORE", bold = true, center = true)
        text("$kind READING", bold = true, center = true)
        text(docNumber ?: "PROVISIONAL - NOT NUMBERED YET", center = true)
        text(listOfNotNull(register, terminal).joinToString(" · ")); cashier?.let { text("Cashier: $it") }; text("As of: $at")
        e += ReceiptElement.Divider()
        row("Receipts", totals.receipts.toString()); row("Sales", peso(totals.grossMinor), true)
        if (totals.voids > 0) row("Voided (${totals.voids})", peso(totals.voidMinor))
        e += ReceiptElement.Divider(); text("Paid by", bold = true)
        if (totals.tenders.isEmpty()) text("  nothing yet") else totals.tenders.forEach { (label, amount) -> row("  $label", peso(amount)) }
        e += ReceiptElement.Divider(); text("Tax", bold = true)
        row("  VATable sales", peso(totals.vatableMinor)); row("  VAT", peso(totals.vatMinor)); row("  VAT exempt", peso(totals.exemptMinor)); row("  Zero rated", peso(totals.zeroMinor))
        if (totals.discounts.isNotEmpty()) {
            e += ReceiptElement.Divider(); text("Discounts", bold = true)
            totals.discounts.forEach { (code, v) -> row("  ${type(code)}", "-" + peso(v.first)); if (v.second > 0) row("  VAT removed", peso(v.second)) }
        }
        if (movements.isNotEmpty()) {
            e += ReceiptElement.Divider(); text("Cash movements", bold = true)
            CashKind.entries.forEach { k -> movements[k]?.let { (count, amount) -> row("  ${k.label} ($count)", if (k.hasAmount) peso(amount) else "") } }
        }
        if (kind == "Z" && sessions.isNotEmpty()) {
            e += ReceiptElement.Divider()
            row("Sessions", sessions.size.toString())
            sessions.count { it.forceClosed }.takeIf { it > 0 }?.let { row("Closed by a supervisor", it.toString()) }
        }
        e += ReceiptElement.Divider()
        text(if (docNumber == null) "Made on this phone. The office numbers it when it syncs." else "Reprint of the office reading.", center = true)
        text("Expected cash is not shown here.", center = true)
        e += ReceiptElement.Feed(4)
        return ReceiptDocument(e)
    }
}
