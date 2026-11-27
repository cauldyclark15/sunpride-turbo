package com.sunpride.field.ui.customers

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ProjectionGrant
import com.sunpride.field.storage.FieldStore
import kotlinx.coroutines.CancellationException
import org.json.JSONObject

/** Load the authorized editor and its encrypted fallback through the same cache contract. */
object SubmittedCustomerProfiles {
    const val ENTITY = "local.customer.editor"

    suspend fun load(store: FieldStore, id: String, preview: Boolean, grant: ProjectionGrant,
        current: () -> Boolean, fetch: () -> JSONObject, signOut: () -> Unit): JSONObject {
        check(!store.isHeld()) { "Verify this account before opening profiles" }
        val cached = store.localCache(ENTITY, id)?.takeUnless { it.tombstone }?.json
        try {
            val result = fetch()
            check(current() && grant.current()) { "Session changed" }
            if (!preview) grant.wrap(result.toString())?.let {
                // Room requires the key to start with keepPrefix. Profile keys are customer
                // IDs, not "editor"; retain just this customer's latest authorized form.
                store.putLocalCache(ENTITY, id, it, System.currentTimeMillis(), id)
            }
            return result
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (e is AuthFailure && e.kind == AuthFailure.Kind.OFFLINE && current())
                return cached?.let { grant.read(it) }?.let(::JSONObject) ?: throw e
            if (!grant.deny()) signOut()
            throw e
        }
    }
}
