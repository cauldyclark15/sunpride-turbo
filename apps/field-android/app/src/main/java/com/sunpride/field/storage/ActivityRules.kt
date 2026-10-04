package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject

/** One activity form a visit intent requires (or offers) — backend rule data, never a code literal. */
data class RuleActivity(val kind: String, val required: Boolean)
/** AND-013 bootstrap `activityRules[]` entry. Unknown intents/kinds stay raw and never satisfy anything. */
data class ActivityRule(val intent: String, val version: String, val activities: List<RuleActivity>)

/** A row of the visit's activity checklist. */
data class ActivityRequirement(val kind: String, val required: Boolean, val status: Status) {
    enum class Status { DONE, TO_DO, UNAVAILABLE }
}

/**
 * Turns the downloaded rules + the visit's intents into the activity forms the person must fill.
 * Shared by the controller and both stores so the UI cannot end a "completed" call around them.
 * A required form this phone cannot capture (unknown kind, or a product form with no account
 * products) is shown as unavailable and does not block End; the server records it as missing.
 */
object ActivityRules {
    /** v1 `visit.checkIn` intents, in display order. */
    val INTENTS = listOf("sell", "collect", "merchandise", "audit", "deliver", "promotion", "complaint", "follow-up")
    /** Forms this app can capture. `order_intent` stays off until order capture is enabled. */
    val FORMS = setOf("call_sheet", "merchandising", "inventory_check", "price_check", "promotion", "note")
    private val PRODUCT_FORMS = setOf("call_sheet", "inventory_check", "price_check")

    fun intentLabel(intent: String) = when (intent) {
        "sell" -> "Sell"; "collect" -> "Collect"; "merchandise" -> "Merchandise"; "audit" -> "Store audit"
        "deliver" -> "Deliver"; "promotion" -> "Promotion"; "complaint" -> "Complaint"; "follow-up" -> "Follow-up"
        else -> intent
    }
    fun kindLabel(kind: String) = when (kind) {
        "call_sheet" -> "Call sheet"; "merchandising" -> "Merchandising"; "inventory_check" -> "Inventory check"
        "price_check" -> "Price check"; "promotion" -> "Promotion check"; "note" -> "Note"
        "order_intent" -> "Order"; else -> "Other activity"
    }

    fun decode(o: JSONObject): ActivityRule {
        val intent = o.get("intent") as? String
        val version = o.get("version") as? String
        val list = o.get("activities") as? JSONArray
        require(!intent.isNullOrBlank() && intent.length <= 40 && !version.isNullOrBlank() && version.length <= 200 &&
            list != null && list.length() <= 16)
        require(o.keys().asSequence().toSet() == setOf("intent", "version", "activities"))
        val activities = (0 until list.length()).map { i ->
            val a = list.get(i) as? JSONObject ?: throw IllegalArgumentException("activity")
            require(a.keys().asSequence().toSet() == setOf("kind", "required"))
            val kind = a.get("kind") as? String
            require(!kind.isNullOrBlank() && kind.length <= 40)
            RuleActivity(kind, a.get("required") as? Boolean ?: throw IllegalArgumentException("required"))
        }
        require(activities.map { it.kind }.distinct().size == activities.size)
        return ActivityRule(intent, version, activities)
    }
    fun encode(rule: ActivityRule): JSONObject = JSONObject().put("intent", rule.intent).put("version", rule.version)
        .put("activities", JSONArray(rule.activities.map { JSONObject().put("kind", it.kind).put("required", it.required) }))

    /** Forms a phone can capture for an account: product forms need the account's call-sheet products. */
    fun capturable(kind: String, sheet: CallSheet?): Boolean = kind in FORMS &&
        (kind !in PRODUCT_FORMS || (sheet != null && sheet.lines.isNotEmpty()))

    /** Union over the visit's intents in rule order; a kind is required if any intent requires it. */
    fun checklist(rules: List<ActivityRule>, intents: List<String>, recorded: Collection<String>,
        capturable: (String) -> Boolean): List<ActivityRequirement> {
        val kinds = LinkedHashMap<String, Boolean>()
        for (rule in rules) if (rule.intent in intents) for (a in rule.activities)
            kinds[a.kind] = (kinds[a.kind] ?: false) || a.required
        return kinds.map { (kind, required) ->
            ActivityRequirement(kind, required, when {
                kind in recorded -> ActivityRequirement.Status.DONE
                !capturable(kind) -> ActivityRequirement.Status.UNAVAILABLE
                else -> ActivityRequirement.Status.TO_DO
            })
        }
    }
    fun missing(checklist: List<ActivityRequirement>) =
        checklist.filter { it.required && it.status == ActivityRequirement.Status.TO_DO }.map { it.kind }

    private fun payload(row: IntentRow) = JSONObject(row.serializedOperation).getJSONObject("payload")
    private fun usable(state: String) = state in setOf("pending", "sending", "done")
    /** The visit's intents as recorded in its own check-in. */
    fun intentsOf(clientVisitId: String, rows: List<Pair<IntentRow, String>>): List<String> =
        rows.firstOrNull { it.first.kind == "visit.checkIn" && it.first.clientVisitId == clientVisitId }
            ?.let { payload(it.first).optJSONArray("intents") }
            ?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
    /** Activity kinds queued or accepted for this visit (review-held rows do not count). */
    fun recordedKinds(clientVisitId: String, rows: List<Pair<IntentRow, String>>): Set<String> = rows
        .filter { it.first.clientVisitId == clientVisitId && it.first.kind == "visit.activity" && usable(it.second) }
        .mapNotNull { payload(it.first).optJSONObject("activity")?.optString("kind")?.takeIf { k -> k.isNotBlank() } }
        .toSet()

    /** Store/controller guard: a "completed" End needs every capturable required form recorded. */
    fun requireForEnd(clientVisitId: String, outcome: String?, rules: List<ActivityRule>,
        rows: List<Pair<IntentRow, String>>, sheet: CallSheet?) {
        if (outcome != "completed") return
        val list = checklist(rules, intentsOf(clientVisitId, rows), recordedKinds(clientVisitId, rows)) { capturable(it, sheet) }
        if (missing(list).isNotEmpty()) throw VisitRuleFailure(VisitRuleFailure.Code.ACTIVITIES_REQUIRED)
    }
}

/** Transactional enqueue checks for structured activities and the End-vs-rules guard. */
object ActivityQueueRules {
    private val FORMS = setOf("merchandising", "promotion", "inventory_check", "price_check")
    suspend fun validate(store: FieldStore, intent: IntentRow) {
        if (intent.kind != "visit.activity" && intent.kind != "visit.checkOut") return
        val payload = runCatching { JSONObject(intent.serializedOperation).optJSONObject("payload") }.getOrNull() ?: return
        val activity = payload.optJSONObject("activity")
        // Notes and call sheets keep their own validation (VisitIntentFactory, CallSheetQueueRules).
        if (intent.kind == "visit.activity" && activity?.optString("kind") !in FORMS) return
        val reference = payload.optString("visitId")
        if (intent.kind == "visit.checkOut" && !reference.startsWith("@checkin:")) return // VisitCallRules owns it
        require(reference.startsWith("@checkin:")) { "A local check-in reference is required" }
        val checkIn = store.intent(reference.removePrefix("@checkin:"))
        if (checkIn == null) {
            require(intent.kind == "visit.checkOut") { "Check in first" }
            return // VisitCallRules.requireEnd owns the not-started case.
        }
        require(checkIn.kind == "visit.checkIn" && checkIn.clientVisitId == intent.clientVisitId)
        val outletId = JSONObject(checkIn.serializedOperation).getJSONObject("payload").getString("outletId")
        val sheet = store.callSheet(outletId)
        if (intent.kind == "visit.activity") {
            com.sunpride.field.ui.diagnosticvisit.ActivityForms.validate(activity ?: error("Missing activity"), sheet)
            return
        }
        ActivityRules.requireForEnd(intent.clientVisitId, payload.optString("outcome"), store.activityRules(),
            store.history().map { it.first to it.second.state }, sheet)
    }
}
