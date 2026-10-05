package com.sunpride.field.storage

import org.json.JSONObject

/**
 * Phone mirror of the server's productive-call rule (`packages/backend/convex/sfa/productive_call.ts`,
 * rule version `productive-call/2026-10-02`). A finished planned call is productive when ANY ONE listed
 * activity was recorded at the visit; the End call outcome alone never makes a call productive. Truck
 * sellers' merchandising counts only with the "visited, no sales due to inventory" marker.
 *
 * The phone records activity forms only (no collections), so it evaluates exactly what it queued.
 */
object ProductiveCall {
    const val ANY_LISTED_ACTIVITY = "any_listed_activity"
    const val TRUCK_SELLER = "truck_seller"
    const val NO_SALES_DUE_TO_INVENTORY = "no_sales_due_to_inventory"

    /** Same order as the server's `PRODUCTIVE_ACTIVITY_CODES`. */
    val CODES = listOf("purchase_order", "merchandising", "inventory_retrieval", "suggested_order",
        "negotiation", "bad_order_pickup", "collection", "meeting")

    /** What one finished call recorded: productive activity codes plus the truck-seller marker. */
    data class Facts(val codes: List<String>, val noSalesDueToInventory: Boolean)

    /** Server `productiveCodesFromVisitRecords` over the phone's own activity kinds and End reason. */
    fun facts(activityKinds: Collection<String>, reasonCode: String?): Facts {
        val codes = mutableSetOf<String>()
        for (kind in activityKinds) when (kind) {
            "order_intent" -> codes.add("purchase_order")
            "merchandising", "price_check" -> codes.add("merchandising")
            "inventory_check" -> codes.add("inventory_retrieval")
            else -> if (kind in CODES) codes.add(kind)
        }
        return Facts(CODES.filter { it in codes },
            reasonCode?.trim()?.lowercase() == NO_SALES_DUE_TO_INVENTORY)
    }

    /**
     * Codes that make the call productive under [rule]. An unknown rule (no report fetched yet, or an older
     * server) is treated as the stricter truck-seller rule, so the phone never claims more than the server.
     */
    fun matched(facts: Facts, rule: String?): List<String> =
        if (rule != ANY_LISTED_ACTIVITY && !facts.noSalesDueToInventory) facts.codes.filter { it != "merchandising" }
        else facts.codes

    fun productive(facts: Facts, rule: String?) = matched(facts, rule).isNotEmpty()

    private fun payload(intent: IntentRow) = JSONObject(intent.serializedOperation).getJSONObject("payload")
    private fun usable(state: String) = state in setOf("pending", "sending", "done")

    /**
     * Facts of the call's latest usable start once it has a usable End; null while the call is open or not
     * started. Activities held for review do not count, matching what the server will accept.
     */
    fun factsOf(rows: List<Pair<IntentRow, String>>): Facts? {
        val start = rows.lastOrNull { it.first.kind == "visit.checkIn" && usable(it.second) }?.first ?: return null
        val own = rows.filter { it.first.clientVisitId == start.clientVisitId }
        if (!VisitCallRules.closed(own)) return null
        val end = own.lastOrNull { it.first.kind == "visit.checkOut" && usable(it.second) }?.first ?: return null
        val kinds = own.filter { it.first.kind == "visit.activity" && usable(it.second) }
            .mapNotNull { payload(it.first).optJSONObject("activity")?.optString("kind")?.takeIf { k -> k.isNotBlank() } }
        val reason = payload(end).let { p -> if (p.isNull("reasonCode")) null else p.optString("reasonCode") }
        return facts(kinds, reason)
    }
}
