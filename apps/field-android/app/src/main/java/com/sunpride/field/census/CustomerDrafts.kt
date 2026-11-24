package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** SP-0241: editable, phone-only enrollments. These never enter the submission outbox. */
data class CustomerDrafts(
    val active: CustomerCapture.Draft? = null,
    val activeId: String? = null,
    val saved: List<Entry> = emptyList(),
) {
    data class Entry(val id: String, val draft: CustomerCapture.Draft) {
        val name: String get() = CustomerCapture.storeName(draft.form).ifBlank { "Unnamed customer" }
    }

    fun keep(draft: CustomerCapture.Draft) = copy(active = draft,
        saved = saved.map { if (it.id == activeId) it.copy(draft = draft) else it })

    /** No completeness/format checks here: even a partly typed number can be completed later. */
    fun save(draft: CustomerCapture.Draft): CustomerDrafts {
        val id = activeId ?: UUID.randomUUID().toString()
        val entry = Entry(id, draft)
        return copy(active = null, activeId = null,
            saved = saved.filterNot { it.id == id } + entry)
    }

    fun open(id: String): CustomerDrafts {
        check(active == null || active.isEmpty()) { "Save the current customer as a draft first." }
        val entry = saved.single { it.id == id }
        return copy(active = entry.draft, activeId = id)
    }

    /** Submit/discard affects only the open enrollment, not other saved drafts. */
    fun clear() = copy(active = null, activeId = null, saved = saved.filterNot { it.id == activeId })

    fun json(): String? {
        if (saved.isEmpty() && (active == null || active.isEmpty())) return null
        val rows = JSONArray()
        saved.forEach { rows.put(JSONObject().put("id", it.id).put("draft", JSONObject(CustomerCapture.draftJson(it.draft)))) }
        return JSONObject().put("version", 2).put("saved", rows).also { o ->
            active?.takeUnless { it.isEmpty() && activeId == null }?.let { o.put("active", JSONObject(CustomerCapture.draftJson(it))) }
            activeId?.let { o.put("activeId", it) }
        }.toString()
    }

    companion object {
        /** Preserve the pre-existing single unfinished form. Refuse corrupt books rather than overwrite them. */
        fun parse(json: String?): CustomerDrafts {
            if (json == null) return CustomerDrafts()
            val o = JSONObject(json)
            if (o.getInt("version") == 1) return CustomerDrafts(active = requireNotNull(CustomerCapture.parseDraft(json)))
            require(o.getInt("version") == 2) { "Unknown customer draft format" }
            val rows = o.getJSONArray("saved")
            val saved = (0 until rows.length()).map { i ->
                val row = rows.getJSONObject(i)
                Entry(UUID.fromString(row.getString("id")).toString(),
                    requireNotNull(CustomerCapture.parseDraft(row.getJSONObject("draft").toString())))
            }
            require(saved.map { it.id }.distinct().size == saved.size)
            val activeId = if (o.has("activeId")) o.getString("activeId") else null
            val active = o.optJSONObject("active")?.let { requireNotNull(CustomerCapture.parseDraft(it.toString())) }
            require(activeId == null || (active != null && saved.any { it.id == activeId }))
            return CustomerDrafts(active, activeId, saved)
        }
    }
}
