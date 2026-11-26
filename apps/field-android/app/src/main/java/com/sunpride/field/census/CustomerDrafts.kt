package com.sunpride.field.census

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Editable phone-owned enrollments (one book, SP-0241: unsent forms and incomplete queued
 * captures). Office sharing uses separate non-approval operations (SP-0244). */
data class CustomerDrafts(
    val active: CustomerCapture.Draft? = null,
    val activeId: String? = null,
    val saved: List<Entry> = emptyList(),
    val awaitingConfirmation: List<Entry> = emptyList(),
) {
    data class Entry(val id: String, val draft: CustomerCapture.Draft,
        val captureRequestId: String? = null, val revision: Int = 0, val previousRequestId: String? = null,
        val existingCustomerId: String? = null, val expectedUpdatedAt: Long? = null, val downloaded: String? = null) {
        val name: String get() = CustomerCapture.storeName(draft.form).ifBlank { "Unnamed customer" }
    }

    fun keep(draft: CustomerCapture.Draft) = copy(active = draft,
        saved = saved.map { if (it.id == activeId) it.copy(draft = draft) else it })

    /** No completeness/format checks here: even a partly typed number can be completed later. */
    fun save(draft: CustomerCapture.Draft): CustomerDrafts {
        val id = activeId ?: UUID.randomUUID().toString()
        val entry = saved.find { it.id == id }?.copy(draft = draft) ?: Entry(id, draft)
        return copy(active = null, activeId = null,
            saved = saved.filterNot { it.id == id } + entry)
    }

    /** Legacy full names stay names, never empty split-name replacements. New forms
     * retain their existing separate-name validation. */
    fun preparePayload(payload: JSONObject) {
        if (saved.none { it.id == activeId && it.existingCustomerId != null }) return
        val customer = payload.optJSONObject("customer") ?: return
        if (CustomerMaster.NAME_FIELDS.all { customer.optString(it.key).isBlank() })
            CustomerMaster.NAME_FIELDS.forEach { customer.remove(it.key) }
    }

    /** Queue an immutable revision and keep unfinished captures in the same editable list.
     * The caller persists this book and the operation in one transaction. */
    fun queued(payload: JSONObject, draft: CustomerCapture.Draft, complete: Boolean): CustomerDrafts {
        preparePayload(payload)
        val id = activeId ?: UUID.randomUUID().toString()
        val old = saved.find { it.id == id }
        val request = payload.getString("captureId")
        val root = old?.captureRequestId ?: request
        payload.put("customerDraftId", id).put("draftRevision", (old?.revision ?: 0) + 1).put("draftIncomplete", !complete)
            .put("customerCaptureRequestId", root)
        old?.previousRequestId?.let { payload.put("previousCustomerRequestId", it) }
        if (old?.existingCustomerId != null && old.revision == 0) {
            payload.put("existingCustomerId", old.existingCustomerId).put("expectedUpdatedAt", old.expectedUpdatedAt)
        }
        val entry = Entry(id, draft, root, (old?.revision ?: 0) + 1, request,
            old?.existingCustomerId, old?.expectedUpdatedAt, old?.downloaded)
        return copy(active = null, activeId = null,
            saved = saved.filterNot { it.id == id } + if (complete) emptyList() else listOf(entry),
            awaitingConfirmation = awaitingConfirmation.filterNot { it.id == id } + if (complete) listOf(entry) else emptyList())
    }

    fun open(id: String): CustomerDrafts {
        check(active == null || active.isEmpty()) { "Save the current customer as a draft first." }
        val entry = saved.single { it.id == id }
        return copy(active = entry.draft, activeId = id)
    }

    /** Submit/discard affects only the open enrollment, not other saved drafts. */
    fun clear() = copy(active = null, activeId = null, saved = saved.filterNot { it.id == activeId })

    /** A synced office completion removes only the matching acknowledged revision, never
     * newer offline work or the form currently being edited. */
    fun reconcile(states: JSONArray): CustomerDrafts {
        val received=(0 until states.length()).map { states.getJSONObject(it) }
        val completed = received.filter { it.optString("completeness") == "complete" }
            .associate { it.getString("draftId") to it.getInt("revision") }
        val drafts=received.filter { it.optString("completeness") == "draft" }
            .associate { it.getString("draftId") to it.getInt("revision") }
        val returned=awaitingConfirmation.filter { drafts[it.id] == it.revision }
        return copy(saved = saved.filterNot { it.id != activeId && it.revision > 0 && completed[it.id] == it.revision } + returned,
            awaitingConfirmation=awaitingConfirmation.filterNot { completed[it.id] == it.revision || drafts[it.id] == it.revision })
    }
    /** A complete downloaded list replaces only unchanged imported forms. Never erase a
     * newer local edit, queued revision, or an open form when office work finishes it. */
    fun mergeDownloaded(rows: List<JSONObject>): CustomerDrafts = mergeImported(rows.map { customer ->
        val id = customer.getString("id")
        val draft = CustomerCapture.downloadedDraft(customer)
        Entry(id, draft, existingCustomerId = id, expectedUpdatedAt = customer.getLong("updatedAt"),
            downloaded = CustomerCapture.draftJson(draft))
    })

    fun mergeImported(incoming: List<Entry>): CustomerDrafts {
        val retained = saved.filterNot { entry ->
            entry.existingCustomerId != null && entry.revision == 0 && entry.id != activeId &&
                entry.downloaded == CustomerCapture.draftJson(entry.draft)
        }
        val known = (retained + awaitingConfirmation).map { it.id }.toSet()
        return copy(saved = retained + incoming.distinctBy { it.id }.filterNot { it.id in known })
    }

    fun json(): String? {
        if (saved.isEmpty() && awaitingConfirmation.isEmpty() && (active == null || active.isEmpty())) return null
        fun rows(entries:List<Entry>)=JSONArray().apply { entries.forEach { put(JSONObject().put("id", it.id).put("draft", JSONObject(CustomerCapture.draftJson(it.draft)))
            .put("captureRequestId", it.captureRequestId).put("revision", it.revision).put("previousRequestId", it.previousRequestId)
            .put("existingCustomerId", it.existingCustomerId).put("expectedUpdatedAt", it.expectedUpdatedAt).put("downloaded", it.downloaded)) } }
        return JSONObject().put("version", 2).put("saved", rows(saved)).put("awaitingConfirmation",rows(awaitingConfirmation)).also { o ->
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
            fun entries(rows:JSONArray) = (0 until rows.length()).map { i ->
                val row = rows.getJSONObject(i)
                Entry(UUID.fromString(row.getString("id")).toString(),
                    requireNotNull(CustomerCapture.parseDraft(row.getJSONObject("draft").toString())),
                    row.optString("captureRequestId").takeIf { it.isNotBlank() && it != "null" }, row.optInt("revision"),
                    row.optString("previousRequestId").takeIf { it.isNotBlank() && it != "null" },
                    row.optString("existingCustomerId").takeIf { it.isNotBlank() && it != "null" }?.also { UUID.fromString(it) },
                    if (row.isNull("expectedUpdatedAt")) null else row.getLong("expectedUpdatedAt"),
                    row.optString("downloaded").takeIf { it.isNotBlank() && it != "null" })
            }
            val saved=entries(o.getJSONArray("saved"))
            val awaiting=entries(o.optJSONArray("awaitingConfirmation") ?: JSONArray())
            require((saved+awaiting).map { it.id }.distinct().size == saved.size+awaiting.size)
            val activeId = if (o.has("activeId")) o.getString("activeId") else null
            val active = o.optJSONObject("active")?.let { requireNotNull(CustomerCapture.parseDraft(it.toString())) }
            require(activeId == null || (active != null && saved.any { it.id == activeId }))
            return CustomerDrafts(active, activeId, saved, awaiting)
        }
    }
}
