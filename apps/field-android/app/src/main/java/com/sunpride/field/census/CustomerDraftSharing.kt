package com.sunpride.field.census

import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** SP-0244: share saved drafts through the durable sync outbox, never through customer submission.
 * Photos stay encrypted on the phone until final submission; office readers see that one was taken.
 */
object CustomerDraftSharing {
    const val KIND = "census.draft"

    fun profile(draft: CustomerCapture.Draft): JSONObject = JSONObject(CustomerCapture.draftJson(draft)).also {
        it.remove("photo")
        it.put("photoPresent", draft.photo != null)
        // Extra photo answers are also sent only with the completed enrollment.
        it.optJSONObject("customFields")?.let { fields ->
            fields.keys().asSequence().toList().forEach { key ->
                if (fields.optString(key).startsWith("data:image/")) fields.put(key, "Photo saved on phone")
            }
        }
    }

    /** Compare only explicitly saved drafts. An unfinished new form remains phone-only until Save as draft.
     * [at] comes from the transaction's monotonically ordered intent clock, including across app restarts.
     */
    fun changes(scope: StoreScope, before: String?, after: String?, at: Long, sharedIds: Set<String> = emptySet()): List<IntentRow> {
        val old = CustomerDrafts.parse(before).saved.associateBy { it.id }
        val next = CustomerDrafts.parse(after).saved.associateBy { it.id }
        return (old.keys + next.keys).mapNotNull { id ->
            val prior = old[id]?.draft?.let(::profile)
            val current = next[id]?.draft?.let(::profile)
            if (id in sharedIds && prior?.toString() == current?.toString()) return@mapNotNull null
            val payload = JSONObject().put("draftId", id).put("revision", at).put("deviceTime", at)
                .put("action", if (current == null) "discard" else "save")
            current?.let { payload.put("profile", it) }
            val requestId = UUID.randomUUID().toString()
            IntentRow(scope.account, scope.deviceId, scope.fingerprint, requestId, id, KIND,
                JSONObject().put("clientRequestId", requestId).put("kind", KIND).put("dependsOn", JSONArray())
                    .put("payload", payload).toString(), at)
        }
    }
}
