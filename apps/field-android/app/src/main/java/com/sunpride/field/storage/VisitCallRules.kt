package com.sunpride.field.storage

import org.json.JSONObject

/** Shared by the controller and the transactional store; the UI cannot bypass call order. */
class VisitRuleFailure(val code: Code) : IllegalStateException(code.text) {
    enum class Code(val text: String) {
        CALL_OPEN("Finish the open call first"), MCP_ORDER("Visit stores in plan order"),
        ALREADY_STARTED("This call has already started"), CALL_NOT_OPEN("Start the call first"),
        ALREADY_ENDED("This call has already ended"), OUTCOME_REQUIRED("Record the call outcome"),
        REASON_REQUIRED("Choose a nonproductive reason"),
        INTENT_REQUIRED("Choose at least one visit purpose"),
        ACTIVITIES_REQUIRED("Record the required activities, or end as not productive"),
        PHOTO_LIMIT("This call already has the most photos the phone keeps")
    }
}

object VisitCallRules {
    private fun payload(intent: IntentRow) = JSONObject(intent.serializedOperation).getJSONObject("payload")
    private fun usable(state: String) = state in setOf("pending", "sending", "done")
    fun sequence(item: SnapshotItem): Int? = JSONObject(item.json).let {
        if (it.has("sequence") && !it.isNull("sequence")) it.getInt("sequence") else null
    }
    // Missing sequence uses its original wire-list position; equal sequences keep list order.
    fun ordered(items: List<SnapshotItem>): List<SnapshotItem> = items.withIndex()
        .sortedBy { runCatching { sequence(it.value) }.getOrNull() ?: it.value.listPosition ?: it.index }.map { it.value }

    fun related(plannedId: String?, outletId: String, day: String,
        rows: List<Pair<IntentRow, String>>): List<Pair<IntentRow, String>> {
        val ids = rows.filter { (intent, _) -> intent.kind == "visit.checkIn" && payload(intent).let {
            it.optString("serviceDate") == day && it.optString("outletId") == outletId &&
                it.optString("plannedVisitId").takeUnless { id -> id.isBlank() || id == "null" } == plannedId
        } }.map { it.first.clientVisitId }.toSet()
        return rows.filter { it.first.clientVisitId in ids }
    }
    fun started(rows: List<Pair<IntentRow, String>>) = rows.any { it.first.kind == "visit.checkIn" && usable(it.second) }
    fun closed(rows: List<Pair<IntentRow, String>>) = rows.any {
        it.first.kind == "visit.checkOut" && usable(it.second) && started(rows.filter { row ->
            row.first.clientVisitId == it.first.clientVisitId }) && payload(it.first).let { p ->
            validOutcome(p.optString("outcome"), p.optString("reasonCode"))
        }
    }
    private fun validOutcome(outcome: String?, reason: String?) = outcome == "completed" ||
        (outcome == "nonproductive" && !reason.isNullOrBlank() && reason != "null")
    fun requireOutcome(outcome: String?, reason: String?) {
        if (outcome !in setOf("completed", "nonproductive")) throw VisitRuleFailure(VisitRuleFailure.Code.OUTCOME_REQUIRED)
        if (!validOutcome(outcome, reason)) throw VisitRuleFailure(VisitRuleFailure.Code.REASON_REQUIRED)
    }
    fun startFailure(plannedId: String?, outletId: String, day: String, plans: List<SnapshotItem>,
        rows: List<Pair<IntentRow, String>>): VisitRuleFailure? = try {
        requireStart(plannedId, outletId, day, plans, rows); null
    } catch (e: VisitRuleFailure) { e }
    fun requireStart(plannedId: String?, outletId: String, day: String, plans: List<SnapshotItem>,
        rows: List<Pair<IntentRow, String>>) {
        val starts = rows.filter { (intent, state) -> intent.kind == "visit.checkIn" && usable(state) &&
            payload(intent).optString("serviceDate") == day }
        if (starts.any { start -> !closed(rows.filter { it.first.clientVisitId == start.first.clientVisitId }) })
            throw VisitRuleFailure(VisitRuleFailure.Code.CALL_OPEN)
        if (started(related(plannedId, outletId, day, rows)))
            throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_STARTED)
        if (plannedId == null) return // Unplanned calls have no MCP position.
        val ordered = ordered(plans)
        val rank = ordered.indexOfFirst { it.id == plannedId }
        fun position(item: SnapshotItem) = sequence(item) ?: item.listPosition ?: plans.indexOf(item)
        val targetPosition = ordered.getOrNull(rank)?.let { position(it) }
        val earlier = ordered.filter { targetPosition != null && position(it) < targetPosition }
        if (earlier.any { plan -> !closed(related(plan.id, JSONObject(plan.json).getString("outletId"), day, rows)) })
            throw VisitRuleFailure(VisitRuleFailure.Code.MCP_ORDER)
    }
    fun requireEnd(clientVisitId: String, end: JSONObject, rows: List<Pair<IntentRow, String>>) {
        val own = rows.filter { it.first.clientVisitId == clientVisitId }
        if (!started(own)) throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
        if (closed(own)) throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
        requireOutcome(end.optString("outcome"), end.optString("reasonCode"))
    }
    /** Outcome (`completed` or `nonproductive`) of the call's usable closing check-out, else null. */
    fun outcome(rows: List<Pair<IntentRow, String>>): String? {
        val start = rows.lastOrNull { it.first.kind == "visit.checkIn" && usable(it.second) }?.first ?: return null
        val end = rows.lastOrNull { it.first.kind == "visit.checkOut" && usable(it.second) &&
            it.first.clientVisitId == start.clientVisitId }?.first ?: return null
        return payload(end).let { p -> p.optString("outcome").takeIf { validOutcome(it, p.optString("reasonCode")) } }
    }
    fun timeSpent(rows: List<Pair<IntentRow, String>>): String? {
        val start = rows.lastOrNull { it.first.kind == "visit.checkIn" && usable(it.second) }?.first ?: return null
        val end = rows.lastOrNull { it.first.kind == "visit.checkOut" && usable(it.second) &&
            it.first.clientVisitId == start.clientVisitId }?.first ?: return null
        val elapsed = payload(end).getLong("deviceTime") - payload(start).getLong("deviceTime")
        return "${(elapsed.coerceAtLeast(0) / 60_000)} min"
    }
}
