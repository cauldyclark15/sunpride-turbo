package com.sunpride.field.storage

import org.json.JSONObject

/** Read-only server calls from a verified v2 bootstrap. Never manufacture local intents or acknowledgements. */
object ServerVisits {
    /** Every state `visit_executions.state` may hold (migration 0105 check); the projection sends it as stored.
     * NF-1: accepting only in-progress/checked-out failed the whole bootstrap for anyone with a completed visit. */
    val STATES = setOf("planned", "arrived", "checked-in", "in-progress", "checked-out", "completed",
        "skipped", "rescheduled", "missed")
    /** A call is under way at the store. */
    val OPEN = setOf("arrived", "checked-in", "in-progress")
    /** The call happened and was closed. */
    val CLOSED = setOf("checked-out", "completed")
    /** The stop is settled without a call; it no longer holds up the route order. */
    val SETTLED = setOf("skipped", "rescheduled", "missed")
    fun attach(plans: List<SnapshotItem>, pages: List<JSONObject>): List<SnapshotItem> {
        val rows = pages.flatMap { page -> page.optJSONArray("visitExecutions")?.let { a ->
            require(a.length() <= 200)
            (0 until a.length()).map { a.getJSONObject(it) }
        } ?: emptyList() }
        require(rows.size <= 200)
        require(rows.map { it.getString("id") }.distinct().size == rows.size)
        return plans.map { plan ->
            val p = JSONObject(plan.json)
            val own = rows.filter { it.optString("plannedVisitId") == plan.id }
            require(own.size <= 1)
            own.singleOrNull()?.let { call ->
                require(call.getString("outletId") == p.getString("outletId") &&
                    call.getString("serviceDate") == p.getString("serviceDate"))
                require(call.getString("state") in STATES)
                p.put("serverExecution", call)
            }
            plan.copy(json = p.toString())
        }
    }
    fun execution(plan: SnapshotItem): JSONObject? = JSONObject(plan.json).optJSONObject("serverExecution")
    fun closed(plan: SnapshotItem) = execution(plan)?.optString("state") in CLOSED
    fun open(plan: SnapshotItem) = execution(plan)?.optString("state") in OPEN
    /** Closed or settled: earlier stops in this state do not block the next one. */
    fun resolved(plan: SnapshotItem) = execution(plan)?.optString("state").let { it in CLOSED || it in SETTLED }
}
