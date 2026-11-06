package com.sunpride.van.vanday

import org.json.JSONArray
import org.json.JSONObject

/**
 * IP-HH2: the van day as the phone gets it (opt-in `params.vanDay`; the server's `vanDay` object, kept inside the cached policy as
 * `policy.vanDay`). Everything is optional: an older server or a phone with no bound truck simply has no [VanDayInfo].
 */
data class CrewMember(val profileId: String, val name: String, val role: String, val pinId: String?, val salt: String?, val hash: String?) {
    /** A person can take over the phone only when the office gave them a PIN. */
    val hasPin: Boolean get() = pinId != null && salt != null && hash != null
    val roleLabel: String get() = when (role) { "seller" -> "Seller"; "helper" -> "Helper"; "driver" -> "Driver"; "relief" -> "Relief seller"; else -> role.replaceFirstChar { it.uppercase() } }
}
data class CrewOnDevice(val profileId: String, val name: String, val role: String, val since: Long?, val tripId: String?)

/** One thing the clerk sent: [sentBase] of a batch ([lotNumber]); the seller counts it. [caseBase] = pieces in a case (0 = unknown). */
data class SentLine(val productId: String, val productCode: String?, val productName: String, val lotId: String?, val lotNumber: String?,
    val expiresAt: Long?, val caseBase: Long, val sentBase: Long, val countedBase: Long?, val shipFirst: Boolean) {
    val key: String get() = "$productId|${lotId ?: ""}"
}
data class VanDayLoad(val plannedLoadId: String?, val loadId: String?, val state: String, val label: String?, val documentNumber: String?, val clerkName: String?,
    val canAccept: Boolean, val waitingForClerk: Boolean, val waitingForSupervisor: Boolean, val canStartTrip: Boolean, val lines: List<SentLine>, val reasons: List<String>)
data class VanDayInfo(val vehicleLabel: String?, val onDevice: CrewOnDevice?, val members: List<CrewMember>, val tripId: String?, val load: VanDayLoad?, val deviceId: String?)

object VanDayCodec {
    private fun str(o: JSONObject, k: String): String? = if (o.isNull(k) || !o.has(k)) null else o.optString(k).takeIf { it.isNotBlank() }
    private fun long(o: JSONObject, k: String): Long? = if (o.isNull(k) || !o.has(k)) null else (o.opt(k)).let { v -> (v as? Number)?.toLong() ?: v.toString().toLongOrNull() }
    private fun objects(a: JSONArray?): List<JSONObject> = if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optJSONObject(it) }

    /** Null when the object is missing or unreadable: the phone then behaves exactly as before the van day existed. */
    fun decode(o: JSONObject?): VanDayInfo? = if (o == null) null else runCatching {
        require(o.optInt("version") == 1)
        val vehicle = o.optJSONObject("device")?.optJSONObject("vehicle")
        val label = vehicle?.let { str(it, "plateNumber") ?: str(it, "vehicleCode") }
        val crew = o.optJSONObject("crew")
        val on = crew?.optJSONObject("onDevice")?.let { CrewOnDevice(it.getString("profileId"), it.getString("name"), it.optString("role", "seller"), long(it, "since"), str(it, "tripId")) }
        val members = objects(crew?.optJSONArray("members")).map { CrewMember(it.getString("profileId"), it.getString("name"), it.optString("role", "seller"), str(it, "pinId"), str(it, "salt"), str(it, "hash")) }
        val load = o.optJSONObject("load")?.let { l ->
            VanDayLoad(str(l, "plannedLoadId"), str(l, "loadId"), l.getString("state"), str(l, "label"), l.optJSONObject("document")?.let { str(it, "number") }, str(l, "clerkName"),
                l.optBoolean("canAccept"), l.optBoolean("waitingForClerk"), l.optBoolean("waitingForSupervisor"), l.optBoolean("canStartTrip"),
                objects(l.optJSONArray("lines")).map { s ->
                    SentLine(s.getString("productId"), str(s, "productCode"), str(s, "productName") ?: str(s, "productCode") ?: "Product", str(s, "lotId"), str(s, "lotNumber"),
                        long(s, "expiresAt"), long(s, "caseBase") ?: 0L, s.getString("sentBase").toLong(), s.optString("countedBase").toLongOrNull(), s.optBoolean("shipFirst"))
                },
                (l.optJSONArray("differenceReasons")?.let { a -> (0 until a.length()).map { a.getString(it) } }) ?: DEFAULT_REASONS)
        }
        VanDayInfo(label, on, members, str(o, "tripId"), load, o.optJSONObject("device")?.let { str(it, "deviceId") })
    }.getOrNull()

    val DEFAULT_REASONS = listOf("short_loaded", "over_loaded", "damaged_at_loading", "wrong_item", "other")
}

/** What the seller counted for each sent batch, and why a count differs. In memory on the accept screen only. */
data class AcceptCount(val countedBase: Long?, val reason: String? = null)

object LoadAccept {
    fun reasonLabel(code: String) = when (code) {
        "short_loaded" -> "Short loaded"; "over_loaded" -> "Over loaded"; "damaged_at_loading" -> "Damaged at loading"; "wrong_item" -> "Wrong item"; "other" -> "Other"
        else -> code.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
    /** "2 CS + 3 PC" / "5 PC" / "1 CS"; [caseBase] 0 or 1 = no case size, all pieces. */
    fun label(base: Long, caseBase: Long, uom: String = "PC"): String {
        val a = kotlin.math.abs(base)
        if (caseBase <= 1L) return "$a $uom"
        val cases = a / caseBase; val rest = a % caseBase
        return when { cases == 0L -> "$rest $uom"; rest == 0L -> "$cases CS"; else -> "$cases CS + $rest $uom" }
    }
    /** Plain words for the difference between what was sent and what was counted: "Short 2 PC", "Over 1 CS", "Matches". */
    fun difference(line: SentLine, counted: Long?, uom: String = "PC"): String = when {
        counted == null -> "Count this line"
        counted == line.sentBase -> "Matches"
        counted < line.sentBase -> "Short ${label(line.sentBase - counted, line.caseBase, uom)}"
        else -> "Over ${label(counted - line.sentBase, line.caseBase, uom)}"
    }
    fun differs(line: SentLine, counted: Long?) = counted != null && counted != line.sentBase
    /** Every line is counted and every line that differs says why (the server refuses otherwise). */
    fun ready(lines: List<SentLine>, counts: Map<String, AcceptCount>, reasons: List<String>): Boolean = lines.isNotEmpty() && lines.all { l ->
        val c = counts[l.key]; c?.countedBase != null && (!differs(l, c.countedBase) || c.reason in reasons)
    }
    fun problem(lines: List<SentLine>, counts: Map<String, AcceptCount>, reasons: List<String>): String? {
        val open = lines.count { counts[it.key]?.countedBase == null }
        val noReason = lines.count { l -> counts[l.key]?.let { it.countedBase != null && differs(l, it.countedBase) && it.reason !in reasons } == true }
        return when { open > 0 -> if (open == 1) "1 line is not counted yet." else "$open lines are not counted yet."
            noReason > 0 -> if (noReason == 1) "Say why the count is different on 1 line." else "Say why the count is different on $noReason lines."
            else -> null }
    }
    /** The `load.accept` payload: every sent batch counted, a reason on each line that differs. */
    fun payload(tripId: String, loadId: String?, lines: List<SentLine>, counts: Map<String, AcceptCount>, note: String?, deviceTime: Long): JSONObject = JSONObject()
        .put("tripId", tripId).apply { loadId?.let { put("loadId", it) } }
        .put("lines", JSONArray(lines.map { l ->
            val c = checkNotNull(counts[l.key]); val counted = checkNotNull(c.countedBase)
            JSONObject().put("productId", l.productId).put("lotId", l.lotId ?: JSONObject.NULL).put("actualBase", counted.toString())
                .apply { if (differs(l, counted)) put("reason", checkNotNull(c.reason)) }
        }))
        .apply { note?.trim()?.takeIf { it.isNotEmpty() }?.let { put("note", it.take(300)) } }.put("deviceTime", deviceTime)
}

/** Who may take over the phone, and the `crew.switch` payload (the proof is made by [com.sunpride.van.security.PinProofs]). */
object CrewSwitch {
    /** Members who have a PIN and are not already the person on the phone. */
    fun candidates(info: VanDayInfo?): List<CrewMember> = info?.members.orEmpty().filter { it.profileId != info?.onDevice?.profileId }
    fun payload(tripId: String, member: CrewMember, proof: String, deviceTime: Long): JSONObject = JSONObject().put("tripId", tripId)
        .put("toProfileId", member.profileId).put("pinId", checkNotNull(member.pinId)).put("proof", proof).put("deviceTime", deviceTime)
    fun phoneLine(info: VanDayInfo?): String? = info?.vehicleLabel?.let { "Phone is on van $it" }
}

enum class StepKind { SYNC, WAIT, ACCEPT_LOAD, CHECK_LOAD, START_TRIP, NEXT_STORE, LOAD_IN, COUNT_CASH, COUNT_STOCK, CLOSE_TRIP, DONE }
enum class StepTarget { NONE, SYNC, ACCEPT_LOAD, LOAD, START, CUSTOMERS, ROUTE_OPS, CASH, STOCK_COUNT, CLOSE_TRIP }
/** The ONE thing Today shows as the main button. [target] is the screen it opens ([StepTarget.NONE] = nothing to do but wait). */
data class NextStep(val kind: StepKind, val title: String, val detail: String, val button: String?, val target: StepTarget)

data class DayFacts(
    val hasTrip: Boolean, val tripStatus: String?, val startPending: Boolean, val loadStatus: String?, val loadConfirmPending: Boolean,
    val vanDay: VanDayInfo?, val tripClosed: Boolean, val cashCounted: Boolean, val stockCounted: Boolean, val routeOps: Boolean,
    val loadInRecorded: Boolean, val nextStore: String?, val storesLeft: Int, val onHold: Boolean, val acceptWaitingToSync: Boolean = false,
    val supervisorName: String? = null,
)

object VanDaySteps {
    fun next(f: DayFacts): NextStep {
        val load = f.vanDay?.load
        if (!f.hasTrip) return NextStep(StepKind.SYNC, if (f.onHold) "Waiting for the office" else "No trip yet",
            if (f.onHold) "Your trip is paused until the office confirms this phone." else "Sync to get today's trip.", "Sync now", StepTarget.SYNC)
        if (f.tripClosed) return NextStep(StepKind.DONE, "Trip closed", "Nothing more to do on this phone.", "See the trip close", StepTarget.CLOSE_TRIP)
        val status = f.tripStatus
        // A trip whose start is saved on this phone is already on the road.
        val onRoad = status == "active" || f.startPending
        if (!onRoad && status in setOf("planned", "loading", "loaded")) {
            if (load != null) when {
                f.acceptWaitingToSync -> return NextStep(StepKind.WAIT, "Your count is saved", "It goes to the office at the next sync. You can start the trip once it is accepted.", "Sync now", StepTarget.SYNC)
                load.canAccept -> return NextStep(StepKind.ACCEPT_LOAD, "Accept the load", "Count what the clerk loaded." + (load.documentNumber?.let { " Document $it." } ?: ""), "Accept load", StepTarget.ACCEPT_LOAD)
                load.waitingForClerk -> return NextStep(StepKind.WAIT, "Waiting for the clerk", "Your count is different from what was sent. " + (load.clerkName ?: "The clerk") + " recounts the truck. Sync to check.", "Sync now", StepTarget.SYNC)
                load.waitingForSupervisor -> return NextStep(StepKind.WAIT, "Waiting for the supervisor", (f.supervisorName ?: "A supervisor") + " decides the load difference. Sync to check.", "Sync now", StepTarget.SYNC)
                load.canStartTrip -> return NextStep(StepKind.START_TRIP, "Start the trip", "The load is accepted and on the truck.", "Start trip", StepTarget.START)
                load.state in setOf("suggested", "approved", "picking", "dispatched") -> return NextStep(StepKind.WAIT, "Your load is being prepared", (load.label ?: "The clerk is getting your load ready") + ". Sync to check.", "Sync now", StepTarget.SYNC)
            }
            if (status == "loading" && f.loadStatus == "planned" && !f.loadConfirmPending) return NextStep(StepKind.CHECK_LOAD, "Check the load", "Count the load before you start.", "Check the load", StepTarget.LOAD)
            if (status == "loaded") return NextStep(StepKind.START_TRIP, "Start the trip", "The load is on the truck.", "Start trip", StepTarget.START)
            return NextStep(StepKind.WAIT, if (f.loadConfirmPending) "Load check saved" else "Waiting for the office", "Sync to check the load.", "Sync now", StepTarget.SYNC)
        }
        if (status in setOf("closing", "reconciling", "review_required")) return NextStep(StepKind.CLOSE_TRIP, "Settle the trip", "Check everything, then close.", "Close trip", StepTarget.CLOSE_TRIP)
        // On the road.
        if (!f.cashCounted && !f.stockCounted && f.nextStore != null) return NextStep(StepKind.NEXT_STORE, "Next store: ${f.nextStore}",
            if (f.storesLeft > 1) "${f.storesLeft} stores left on your route." else "Last store on your route.", "Open customers", StepTarget.CUSTOMERS)
        if (f.routeOps && !f.loadInRecorded && !f.cashCounted) return NextStep(StepKind.LOAD_IN, "Load-in at the depot", "Record the stock you bring back, then settle.", "Route controls", StepTarget.ROUTE_OPS)
        if (!f.cashCounted) return NextStep(StepKind.COUNT_CASH, "Count your cash", "The route is done. Count the cash you collected.", "Count cash", StepTarget.CASH)
        if (!f.stockCounted) return NextStep(StepKind.COUNT_STOCK, "Count the truck stock", "Compare the truck with the physical count.", "Count stock", StepTarget.STOCK_COUNT)
        return NextStep(StepKind.CLOSE_TRIP, "Close the trip", "Check everything, then close.", "Close trip", StepTarget.CLOSE_TRIP)
    }
}
