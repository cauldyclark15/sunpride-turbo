package com.sunpride.field.ui.customers

import com.sunpride.field.storage.CallSheetHeader
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.SnapshotItem
import com.sunpride.field.ui.VisitDisplay
import org.json.JSONObject
import java.text.Normalizer
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** One planned call for this outlet in the downloaded horizon (today plus the next days). */
data class PlannedCall(val serviceDate: String, val plannedVisitId: String, val intents: List<String>)

/** Something this phone recorded at the outlet, newest first. Never office history (not on the wire). */
data class HistoryEntry(val at: Long, val label: String, val state: String)

data class CustomerTask(val kind: String, val required: Boolean)

/**
 * Everything the phone knows about one outlet in the signed-in person's downloaded scope.
 * The server only sends outlets on this person's own plan, so the directory is scoped by
 * construction; nothing here widens it.
 */
data class CustomerRecord(
    val outletId: String,
    val name: String,
    val outletCode: String? = null,
    val customerCode: String? = null,
    val address: String? = null,
    val latitude: Double? = null,
    val longitude: Double? = null,
    val routeId: String? = null,
    /** Code of the person's downloaded route when this outlet is on it. */
    val routeCode: String? = null,
    /** Annex C account header, when the office set one up for this account. */
    val account: CallSheetHeader? = null,
    val planned: List<PlannedCall> = emptyList(),
    val history: List<HistoryEntry> = emptyList(),
    /** Today's planned call (with its live status) when there is one. */
    val today: VisitDisplay? = null,
    /** The store's own owner contact (Add store, approved Edit store, office edit); wins over the account header. */
    val ownerName: String? = null,
    val ownerPhone: String? = null,
    /** FLD-207: a call on this store is open (an unplanned call has no [today] row). */
    val callOpen: Boolean = false,
) {
    /** The chip on the Stores row: today's planned status, else "In progress" for an open unplanned call. */
    val visitStatus: String? get() = today?.status?.takeIf { it in setOf("Done", "In progress", "Needs review") }
        ?: "In progress".takeIf { callOpen }
    /** Who to ask for and the number Call dials: the store's owner contact, else the account header. */
    val contactName: String? get() = ownerName ?: account?.buyerName
    val contactPhone: String? get() = ownerPhone ?: account?.contactNumber
    /** A shape the daily-route navigation helper understands. */
    fun asVisit(): VisitDisplay = today ?: VisitDisplay(name, "", "", outletId, outletCode = outletCode,
        customerCode = customerCode, address = address, latitude = latitude, longitude = longitude)
}

object CustomerDirectory {
    /**
     * FLD-052: the account rows under Summary, then the note shown when none of them can be drawn.
     * The Account row is skipped when it only repeats the store name.
     */
    fun accountFacts(record: CustomerRecord): Pair<List<Pair<String, String>>, String?> {
        val account = record.account
        val facts = listOfNotNull(
            account?.takeIf { it.accountName != record.name }?.let { "Account" to it.accountName },
            record.contactName?.let { (if (record.ownerName != null) "Owner" else "Buyer") to it },
            record.contactPhone?.let { "Contact" to it },
            account?.accountInCharge?.let { "Account in charge" to it },
            account?.receivingInCharge?.let { "Receiving" to it },
            account?.distributorName?.let { "Distributor" to it },
            account?.distributorSchedule?.let { "Delivery schedule" to it },
            account?.foc?.let { "FOC" to it },
        )
        // r4: a sheet holding only the store's name (the sample sheets) used to leave Summary silent about the account.
        val note = when {
            account == null -> "No account sheet yet"
            facts.isEmpty() -> "No account details yet"
            else -> null
        }
        return facts to note
    }

    private const val HISTORY_LIMIT = 10
    private val manila: ZoneId = ZoneId.of("Asia/Manila")

    private fun JSONObject.text(key: String): String? =
        takeIf { has(key) && !isNull(key) }?.opt(key)?.let { it as? String }?.trim()?.takeIf { it.isNotEmpty() }
    private fun JSONObject.number(key: String): Double? =
        takeIf { has(key) && !isNull(key) }?.opt(key)?.let { (it as? Number)?.toDouble() }?.takeIf { it.isFinite() }

    /**
     * Pure projection of the active cached snapshot. [today] is the decorated list Today already
     * shows, so status and call order are the same values Start enforces.
     */
    fun build(
        outlets: List<SnapshotItem>,
        customers: Map<String, String>,
        visits: List<SnapshotItem>,
        routeJson: String?,
        accounts: Map<String, CallSheetHeader>,
        history: List<Pair<IntentRow, String>>,
        today: List<VisitDisplay>,
    ): List<CustomerRecord> {
        val route = routeJson?.let { runCatching { JSONObject(it) }.getOrNull() }
        val routeId = route?.text("id")
        val routeCode = route?.text("code")
        val plansByOutlet = visits.mapNotNull { row ->
            val v = runCatching { JSONObject(row.json) }.getOrNull() ?: return@mapNotNull null
            val outlet = v.text("outletId") ?: return@mapNotNull null
            outlet to PlannedCall(row.serviceDate ?: v.text("serviceDate") ?: return@mapNotNull null, row.id,
                v.optJSONArray("intents")?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } } ?: emptyList())
        }.groupBy({ it.first }, { it.second })
        val historyByOutlet = historyByOutlet(history)
        val open = runCatching { com.sunpride.field.storage.VisitCallRules.openOutlets(history) }.getOrDefault(emptySet())
        return outlets.mapNotNull { row ->
            val o = runCatching { JSONObject(row.json) }.getOrNull() ?: return@mapNotNull null
            val latitude = o.number("latitude")?.takeIf { it in -90.0..90.0 }
            val longitude = o.number("longitude")?.takeIf { it in -180.0..180.0 }
            val pinned = latitude != null && longitude != null
            val outletRoute = o.text("routeId")
            CustomerRecord(row.id, o.text("name") ?: "Store", o.text("code"),
                o.text("customerId")?.let { customers[it] }?.trim()?.takeIf { it.isNotEmpty() },
                o.text("address"), latitude.takeIf { pinned }, longitude.takeIf { pinned }, outletRoute,
                routeCode.takeIf { outletRoute != null && outletRoute == routeId }, accounts[row.id],
                plansByOutlet[row.id].orEmpty().sortedBy { it.serviceDate }.distinctBy { it.plannedVisitId },
                historyByOutlet[row.id].orEmpty(), today.firstOrNull { it.outletId == row.id },
                o.text("ownerName"), o.text("ownerPhone"), callOpen = row.id in open)
        }.distinctBy { it.outletId }
    }

    /** Group every local intent under the outlet of its call's check-in, newest first. */
    fun historyByOutlet(rows: List<Pair<IntentRow, String>>): Map<String, List<HistoryEntry>> {
        val outletOfCall = rows.mapNotNull { (intent, _) ->
            if (intent.kind != "visit.checkIn") return@mapNotNull null
            val outlet = payload(intent)?.text("outletId") ?: return@mapNotNull null
            intent.clientVisitId to outlet
        }.toMap()
        return rows.mapNotNull { (intent, state) ->
            val outlet = outletOfCall[intent.clientVisitId] ?: return@mapNotNull null
            val p = payload(intent) ?: return@mapNotNull null
            val at = p.optLong("deviceTime", intent.createdAt)
            outlet to HistoryEntry(at, label(intent.kind, p), stateLabel(state))
        }.groupBy({ it.first }, { it.second })
            .mapValues { (_, entries) -> entries.sortedByDescending { it.at }.take(HISTORY_LIMIT) }
    }

    private fun payload(intent: IntentRow) =
        runCatching { JSONObject(intent.serializedOperation).getJSONObject("payload") }.getOrNull()

    private fun label(kind: String, p: JSONObject): String = when (kind) {
        "visit.checkIn" -> if (p.text("plannedVisitId") == null || p.text("plannedVisitId") == "null")
            "Unplanned call started" else "Call started"
        "visit.checkOut" -> when (p.text("outcome")) {
            "completed" -> "Call ended · Completed"
            "nonproductive" -> "Call ended · Not productive" + (p.text("reasonCode")?.let { " ($it)" } ?: "")
            else -> "Call ended"
        }
        else -> when (p.optJSONObject("activity")?.text("kind")) {
            "call_sheet" -> "Call sheet saved"
            "note" -> "Note added"
            else -> "Activity recorded"
        }
    }

    private fun stateLabel(state: String) = when (state) {
        "done" -> "Sent"
        "review" -> "Needs review"
        "pending", "sending" -> "Waiting to send"
        else -> "Saved"
    }

    /** Lower-case, accent-free text so "Pena" finds "Peña" and "sto nino" finds "Sto. Niño". */
    fun normalize(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFD)
        .replace(Regex("\\p{M}+"), "").lowercase(Locale.ROOT)
        .replace(Regex("[^a-z0-9]+"), " ").trim()

    /**
     * Compact code form, the same rule as the office store search (`store-search.js`): no spaces,
     * dashes or punctuation, letter O read as zero inside the number, leading zeros ignored, so
     * "SMP-O0069", "smp00069" and "SMP-00069" are one code.
     */
    fun compactCode(value: String): String {
        val s = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)
            .replace(Regex("[\\s.\\-/#_\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]"), "")
        val m = Regex("^([a-z]*?)([0-9o]*[0-9][0-9o]*)$").find(s) ?: return s
        val number = m.groupValues[2].replace('o', '0').replace(Regex("^0+(?=\\d)"), "")
        return m.groupValues[1] + number
    }

    private fun fields(record: CustomerRecord) = listOfNotNull(record.name, record.outletCode, record.customerCode,
        record.address, record.account?.accountName, record.contactName, record.routeCode)

    /**
     * Offline search over the cached directory. Every word must appear somewhere (name, codes,
     * address, account or buyer name, route). Exact code matches rank first, then name prefixes,
     * then today's route order, then name. A blank query lists everything.
     */
    fun search(records: List<CustomerRecord>, query: String): List<CustomerRecord> {
        val words = normalize(query).split(' ').filter { it.isNotEmpty() }
        val whole = compactCode(query)
        val ranked = records.mapNotNull { record ->
            val haystack = fields(record).map { normalize(it) }
            val joined = haystack.joinToString(" ")
            val rawCodes = listOfNotNull(record.outletCode, record.customerCode)
            val compact = rawCodes.map { compactCode(it) }
            val wholeCode = words.isNotEmpty() && whole.isNotEmpty() &&
                compact.any { it == whole || (whole.length >= 3 && it.contains(whole)) }
            fun wordMatches(word: String): Boolean = joined.contains(word) ||
                compactCode(word).let { cw -> cw.length >= 2 && compact.any { it.contains(cw) } }
            if (!wholeCode && words.any { word -> !wordMatches(word) }) return@mapNotNull null
            val phrase = words.joinToString(" ")
            val codes = rawCodes.map { normalize(it) }
            val name = normalize(record.name)
            val score = when {
                words.isEmpty() -> 3
                codes.any { it == phrase } || compact.any { it == whole } -> 0
                codes.any { it.startsWith(phrase) } || name.startsWith(phrase) -> 1
                name.split(' ').any { it.startsWith(words.first()) } -> 2
                else -> 3
            }
            Triple(record, score, record.today?.let { it.sequence ?: it.listPosition } ?: Int.MAX_VALUE)
        }
        return ranked.sortedWith(compareBy<Triple<CustomerRecord, Int, Int>> { it.second }
            .thenBy { if (it.first.today != null) 0 else 1 }.thenBy { it.third }
            .thenBy { normalize(it.first.name) }).map { it.first }
    }

    /** "Today", "Tomorrow" or "Tue, Oct 6" relative to the Manila service day. */
    fun dayLabel(serviceDate: String, now: Long): String {
        val today = Instant.ofEpochMilli(now).atZone(manila).toLocalDate()
        val date = runCatching { LocalDate.parse(serviceDate) }.getOrNull() ?: return serviceDate
        return when (date) {
            today -> "Today"
            today.plusDays(1) -> "Tomorrow"
            else -> date.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.ENGLISH))
        }
    }

    fun timeLabel(at: Long, now: Long): String {
        val time = Instant.ofEpochMilli(at).atZone(manila)
        val clock = time.format(DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH))
        return if (time.toLocalDate() == Instant.ofEpochMilli(now).atZone(manila).toLocalDate()) clock
        else "${time.format(DateTimeFormatter.ofPattern("MMM d", Locale.ENGLISH))}, $clock"
    }

    /** Human label for a planned activity or task kind such as `merchandise_check`. */
    fun kindLabel(kind: String) = kind.replace('_', ' ').replace('.', ' ').trim()
        .replaceFirstChar { it.uppercase() }

    /** A `tel:` URI for the dialer (no call permission needed), or null when the text is not a number. */
    fun dialUri(contact: String?): String? {
        val raw = contact?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (!raw.matches(Regex("[+0-9() .\\-]{7,20}"))) return null
        val digits = raw.filter { it.isDigit() || it == '+' }
        if (digits.count { it.isDigit() } < 7 || digits.lastIndexOf('+') > 0) return null
        return "tel:$digits"
    }

    /** The call's live status/time is only meaningful for today's planned visit. */
    fun todayStatus(record: CustomerRecord): String? = record.today?.let { visit ->
        listOfNotNull(visit.status.takeUnless { it == "Scheduled" || it.isBlank() } ?: "Not started", visit.timeSpent)
            .joinToString(" · ")
    }
}
