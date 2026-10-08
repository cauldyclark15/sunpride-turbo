package com.sunpride.field.location

import com.sunpride.field.storage.FieldStore
import com.sunpride.field.sync.BootstrapFailure
import kotlinx.coroutines.sync.Mutex
import org.json.JSONObject

/** What one upload run achieved. */
data class PingUpload(val sent: Int = 0, val refused: Int = 0, val remaining: Int = 0,
    /** Try again later (offline, server busy, malformed answer). */
    val retryLater: Boolean = false,
    /** The device/session was refused (401): keep the buffer, never retry blindly. */
    val unauthorized: Boolean = false)

/**
 * Uploads buffered live-map pings in batches of at most 100 through the signed device gateway
 * (`post(path, bytes)` = SignedVisitGateway). Each ping gets its own answer: accepted and
 * duplicate are done; a refusal (`too_frequent`, `outside_work_hours`, `too_old`, …) is final
 * for that ping and is dropped too, so one bad ping never blocks the rest. Bytes are the stored
 * wire JSON, so a retry after an unknown outcome resends the same clientPingId (idempotent).
 */
class LocationUploader(private val store: FieldStore, private val deviceId: String,
    private val post: (String, ByteArray) -> Pair<Int, String>) {
    companion object {
        private val flight = Mutex()
        const val MAX_BATCHES = 20
    }

    suspend fun run(): PingUpload {
        if (!flight.tryLock()) return PingUpload(remaining = store.pendingPingCount(), retryLater = true)
        try {
            if (store.isHeld()) return PingUpload(remaining = store.pendingPingCount())
            var sent = 0; var refused = 0
            repeat(MAX_BATCHES) {
                val batch = store.pendingPings(PingCodec.MAX_BATCH)
                if (batch.isEmpty()) return PingUpload(sent, refused, 0)
                val ids = batch.map { it.clientPingId }
                val (code, text) = try { post(PingCodec.PATH, PingCodec.request(deviceId, batch.map { it.json })) }
                    catch (e: kotlinx.coroutines.CancellationException) { throw e }
                    catch (_: BootstrapFailure) { return PingUpload(sent, refused, store.pendingPingCount(), retryLater = true) }
                    catch (_: java.io.IOException) { return PingUpload(sent, refused, store.pendingPingCount(), retryLater = true) }
                if (code == 401) return PingUpload(sent, refused, store.pendingPingCount(), unauthorized = true)
                if (code == 400 && errorCode(text) == "invalid_request") {
                    // A whole-batch shape refusal is permanent for these bytes; drop them rather than loop forever.
                    store.removePings(ids); refused += ids.size; return@repeat
                }
                if (code !in 200..299) return PingUpload(sent, refused, store.pendingPingCount(), retryLater = true)
                val results = runCatching { PingCodec.results(text, ids) }.getOrNull()
                    ?: return PingUpload(sent, refused, store.pendingPingCount(), retryLater = true)
                store.removePings(ids)
                results.forEach { if (it.status == "rejected") refused++ else sent++ }
            }
            val left = store.pendingPingCount()
            return PingUpload(sent, refused, left, retryLater = left > 0)
        } finally { flight.unlock() }
    }

    private fun errorCode(text: String): String? = runCatching {
        val o = JSONObject(text)
        o.optJSONObject("error")?.optString("code")?.takeIf { it.isNotBlank() } ?: o.optString("code").takeIf { it.isNotBlank() }
    }.getOrNull()
}
