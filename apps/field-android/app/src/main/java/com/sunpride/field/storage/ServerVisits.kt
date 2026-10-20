package com.sunpride.field.storage

import org.json.JSONObject

/** Read-only server calls from a verified v2 bootstrap. Never manufacture local intents or acknowledgements. */
object ServerVisits {
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
                require(call.getString("state") in setOf("in-progress", "checked-out"))
                p.put("serverExecution", call)
            }
            plan.copy(json = p.toString())
        }
    }
    fun execution(plan: SnapshotItem): JSONObject? = JSONObject(plan.json).optJSONObject("serverExecution")
    fun closed(plan: SnapshotItem) = execution(plan)?.optString("state") == "checked-out"
}
