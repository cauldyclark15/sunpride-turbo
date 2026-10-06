package com.sunpride.van.sync

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.storage.RoomVanStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import java.util.concurrent.ConcurrentHashMap

/** Process-wide partition mutex shared by foreground and WorkManager instances. */
class VanSync(private val store: VanSyncStore, private val gateway: VanGateway, private val clock: () -> Long = System::currentTimeMillis) {
    private val mutex = locks.getOrPut(store.scope) { Mutex() }
    suspend fun syncNow() {
        if (!mutex.tryLock()) return
        try {
            store.resetSending() // recover transient markers after process interruption
            store.replaceBootstrap(gateway.bootstrap())
            while (true) {
                val pending = store.pending()
                if (pending.isEmpty()) break
                store.markSending(pending.map { it.clientRequestId })
                try {
                    val results = gateway.push(pending)
                    // No response can acknowledge a different request, duplicate or missing item.
                    if (results.size != pending.size || results.map { it.clientRequestId }.toSet() != pending.map { it.clientRequestId }.toSet()) throw VanWireFailure()
                    pending.forEach { row ->
                        kotlinx.coroutines.currentCoroutineContext().ensureActive()
                        store.recordResult(row,results.single { it.clientRequestId == row.clientRequestId })
                    }
                } catch (e: VanSyncFailure) {
                    if (!e.retryable && e.code == "invalid_request") pending.forEach {
                        store.recordResult(it,com.sunpride.van.data.PushResult(it.kind,it.clientRequestId,"rejected",code="invalid_request"))
                    } else throw e
                }
            }
            // Pull authoritative post-operation trip/load/balance, then settle acked movements.
            store.replaceBootstrap(gateway.bootstrap())
            store.setHealth("synced",clock())
        } catch (e: CancellationException) {
            throw e
        } catch (e: VanSyncFailure) {
            if (e.code == "unauthorized") store.hold() else store.setHealth(if (e.code == "version_unsupported") "update_required" else "retry_pending")
            throw e
        } catch (e: AuthFailure) {
            if (e.kind in setOf(AuthFailure.Kind.SESSION_EXPIRED,AuthFailure.Kind.REFUSED)) store.hold() else store.setHealth("retry_pending")
            throw e
        } catch (e: Exception) {
            store.setHealth("retry_pending"); throw e
        } finally {
            try { withContext(NonCancellable) { store.resetSending() } }
            finally { mutex.unlock() }
        }
    }
    companion object { private val locks = ConcurrentHashMap<com.sunpride.van.storage.StoreScope,Mutex>() }
}
