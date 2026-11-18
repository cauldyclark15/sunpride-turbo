package com.sunpride.field.sync

import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.StoreScope

/** One foreground/background sync: renew the verified download when needed, then send saved work.
 * SP-0198: a fresh download is not a substitute for flushing the outbox in this same attempt.
 * Only the bootstrap's verified swap may release held work; a different scope never adopts it.
 */
class FieldSyncSession(
    private val subject: String,
    private val deviceId: String,
    private val stores: (StoreScope) -> FieldStore,
    private val bootstrap: () -> String,
    private val gateway: SignedVisitGateway,
    private val afterSync: suspend (FieldStore) -> Unit = {},
) {
    suspend fun sync(cached: StoreScope?): StoreScope {
        require(cached == null || cached.account == subject && cached.deviceId == deviceId)
        val reusable = cached?.let { scope ->
            val store = stores(scope)
            try { store.workforceSnapshotCurrent() && store.cursor() != null }
            finally { store.close() }
        } == true
        fun download() = StoreScope(subject, deviceId, bootstrap())
        var current = if (reusable) checkNotNull(cached) else download()
        val active = current
        val store = stores(active)
        try {
            VisitSync(gateway, store, active, bootstrap = { current = download() }).sync()
            afterSync(store)
        } finally { store.close() }
        return current
    }
}
