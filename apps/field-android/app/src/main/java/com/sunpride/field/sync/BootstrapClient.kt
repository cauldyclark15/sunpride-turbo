package com.sunpride.field.sync

import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexDeviceApi
import com.sunpride.field.auth.ConvexFunctions
import com.sunpride.field.auth.JSON_MEDIA
import com.sunpride.field.auth.defaultHttpClient
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.RequestSigner
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.StoreScope
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.time.LocalDate
import java.time.ZoneId

class BootstrapFailure(val kind: Kind) : Exception(kind.name) {
    enum class Kind { OFFLINE, RETRYABLE, UNAUTHORIZED, REMOVED, UPDATE_REQUIRED, RESTART, INVALID_RESPONSE }
}

interface BootstrapTransport {
    /** Fresh challenge for every HTTP attempt, including 401 retries. */
    fun challenge(deviceId: String): Pair<String, Long>
    fun token(refresh: Boolean): String
    fun post(body: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String>
}

class LiveBootstrapTransport(
    private val environment: AppEnvironment,
    private val auth: AuthClient,
    functions: ConvexFunctions,
    private val http: OkHttpClient = defaultHttpClient()
) : BootstrapTransport {
    private val devices = ConvexDeviceApi(functions)
    override fun challenge(deviceId: String) = devices.challenge(deviceId)
    override fun token(refresh: Boolean) = auth.convexToken(forceRefresh = refresh)
    override fun post(body: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
        val builder = Request.Builder().url(environment.siteUrl.trimEnd('/') + PATH)
            .header("Authorization", "Bearer $bearer")
        headers.forEach { (key, value) -> builder.header(key, value) }
        val request = builder.post(body.toRequestBody(JSON_MEDIA)).build()
        return try { http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() } }
        catch (_: IOException) { throw BootstrapFailure(BootstrapFailure.Kind.OFFLINE) }
    }
    companion object { const val PATH = "/mobile/v1/bootstrap" }
}

/** Bounded single-flight foreground bootstrap. Pages stay in memory until a complete, consistent final page. */
class BootstrapClient(private val transport: BootstrapTransport, private val signer: DeviceSigner,
                      private val deviceId: String, private val store: (String) -> FieldStore,
                      private val monotonicMillis: () -> Long = { System.nanoTime() / 1_000_000 }) {
    @Synchronized fun fetch(day: String = LocalDate.now(ZoneId.of("Asia/Manila")).toString(),
                            subject: String): BootstrapPage {
        require(subject.isNotBlank())
        for (restart in 0..1) {
            val pages = mutableListOf<BootstrapPage>()
            val seen = mutableSetOf<String>()
            var next: String? = null
            try {
                for (index in 1..100) {
                    val body = BootstrapCodec.request(deviceId, day, next)
                    val (code, text) = send(body)
                    if (code !in 200..299) {
                        val error = runCatching { BootstrapCodec.error(text) }.getOrNull()
                        throw when {
                            code == 401 -> BootstrapFailure(BootstrapFailure.Kind.UNAUTHORIZED)
                            error?.code == "device_revoked" -> BootstrapFailure(BootstrapFailure.Kind.REMOVED)
                            error?.code == "version_unsupported" -> BootstrapFailure(BootstrapFailure.Kind.UPDATE_REQUIRED)
                            error?.code in setOf("rebootstrap_required", "invalid_cursor") -> BootstrapFailure(BootstrapFailure.Kind.RESTART)
                            code >= 500 || error?.retryable == true -> BootstrapFailure(BootstrapFailure.Kind.RETRYABLE)
                            else -> BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE)
                        }
                    }
                    val p = try { BootstrapCodec.page(text) } catch (_: WireFailure) {
                        throw BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE)
                    }
                    if (p.page != index || !p.supported || p.fingerprint.isBlank() ||
                        (pages.isNotEmpty() && (p.fingerprint != pages.first().fingerprint ||
                            p.employee.optString("id") != pages.first().employee.optString("id"))))
                        throw BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE)
                    pages.add(p)
                    next = p.next
                    if (next == null) {
                        val scoped = store(p.fingerprint)
                        val snapshot = try { BootstrapCodec.snapshot(pages) } catch (_: Exception) {
                            throw BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE)
                        }
                        // Scope is constructed by caller from an authenticated subject, never from a UI picker.
                        // Existing held work for the *same* subject/device/scope resumes only after successful proof.
                        try {
                            kotlinx.coroutines.runBlocking {
                                val generation = scoped.stage(snapshot)
                                scoped.swap(generation, p.cursor ?: throw BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE),
                                    p.lease, p.cache, releaseHeld = true)
                            }
                        } finally { scoped.close() }
                        return p
                    }
                    if (!seen.add(next)) throw BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE)
                }
                throw BootstrapFailure(BootstrapFailure.Kind.INVALID_RESPONSE)
            } catch (e: BootstrapFailure) {
                if (e.kind == BootstrapFailure.Kind.RESTART && restart == 0) continue
                throw e
            }
        }
        throw BootstrapFailure(BootstrapFailure.Kind.RESTART)
    }

    private fun send(body: ByteArray): Pair<Int, String> {
        for (attempt in 0..1) {
            // Obtain JWT first: if token exchange fails, don't issue an unused challenge.
            val bearer = transport.token(attempt != 0)
            val received = monotonicMillis()
            val (nonce, expiresAt) = transport.challenge(deviceId)
            val timestamp = expiresAt - 60_000L + (monotonicMillis() - received)
            val headers = RequestSigner.headers(signer, deviceId, LiveBootstrapTransport.PATH, body, nonce, timestamp)
            val result = transport.post(body, headers, bearer)
            if (result.first != 401) return result
        }
        return 401 to ""
    }
}
