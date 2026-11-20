package com.sunpride.field.storage

import org.json.JSONObject
import java.util.UUID

/** SP-0225: office-planned, self-reported tasks. Never grants productive-call or cash/stock credit. */
data class StoreActivity(val activityId: String, val name: String, val done: Boolean = false)
data class StoreWork(val routineName: String? = null, val activities: List<StoreActivity> = emptyList()) {
    companion object {
        fun decode(o: JSONObject?): StoreWork {
            if (o == null) return StoreWork()
            val a = o.getJSONArray("activities"); require(a.length() <= 50)
            val rows = (0 until a.length()).map { i ->
                val row = a.getJSONObject(i)
                val id = row.getString("activityId"); require(UUID.fromString(id).toString() == id)
                val name = row.getString("name"); require(name.isNotBlank() && name.length <= 200)
                val done = if (row.has("done")) row.get("done").also { require(it is Boolean) } as Boolean else false
                StoreActivity(id, name, done)
            }
            require(rows.map { it.activityId }.distinct().size == rows.size)
            val routine = if (o.has("routineName")) o.getString("routineName").also { require(it.isNotBlank() && it.length <= 200) } else null
            return StoreWork(routine, rows)
        }
        fun activity(activityId: String, done: Boolean): JSONObject {
            require(UUID.fromString(activityId).toString() == activityId)
            return JSONObject().put("kind", "planned_activity").put("activityId", activityId).put("done", done)
        }
        /** Outbox order is durable. A refused tick is visible as review, never as successful work. */
        fun state(task: StoreActivity, rows: List<Pair<IntentRow, String>>): Pair<Boolean, String> {
            val latest = rows.lastOrNull { (row, _) -> row.kind == "visit.activity" && runCatching {
                val a = JSONObject(row.serializedOperation).getJSONObject("payload").getJSONObject("activity")
                a.optString("kind") == "planned_activity" && a.optString("activityId") == task.activityId
            }.getOrDefault(false) } ?: return task.done to if (task.done) "Marked done" else "Not marked done"
            val (row, status) = latest
            if (OutboxState.refused(status)) {
                val before = rows.takeWhile { it.first.requestId != row.requestId }
                return state(task, before).first to "Needs office review"
            }
            val done = JSONObject(row.serializedOperation).getJSONObject("payload").getJSONObject("activity").getBoolean("done")
            return done to if (status == "done") { if (done) "Marked done" else "Not marked done" } else "Saved on phone · waiting to send"
        }
    }
}
