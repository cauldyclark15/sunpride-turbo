package com.sunpride.van.sync

import com.sunpride.van.AppEnvironment
import com.sunpride.van.auth.*
import com.sunpride.van.data.PushResult
import com.sunpride.van.device.DeviceSigner
import com.sunpride.van.device.RequestSigner
import com.sunpride.van.storage.OutboxRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

class VanSyncFailure(val code: String, val retryable: Boolean) : Exception("Van sync: $code", null)

interface VanGateway {
    suspend fun evidence(sha256: String, jpeg: ByteArray) { throw VanSyncFailure("temporarily_unavailable",true) }
    suspend fun bootstrap(): String
    suspend fun push(operations: List<OutboxRow>): List<PushResult>
}
interface VanTransport {
    fun token(refresh: Boolean): String
    fun challenge(deviceId: String): Pair<String,Long>
    fun post(path: String, body: ByteArray, headers: Map<String,String>, bearer: String): Pair<Int,String>
}
class LiveVanTransport(private val environment: AppEnvironment, private val auth: AuthClient,
    functions: ConvexFunctions, private val http: OkHttpClient = defaultHttpClient()) : VanTransport {
    private val devices = ConvexDeviceApi(functions)
    override fun token(refresh: Boolean) = auth.convexToken(forceRefresh=refresh)
    override fun challenge(deviceId: String) = devices.challenge(deviceId)
    override fun post(path: String, body: ByteArray, headers: Map<String,String>, bearer: String): Pair<Int,String> {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val builder = Request.Builder().url(environment.siteUrl.trimEnd('/')+path).header("Authorization","Bearer $bearer")
        headers.forEach { (k,v) -> builder.header(k,v) }
        // No manual Accept-Encoding: OkHttp handles gzip transparently.
        return try { http.newCall(builder.post(body.toRequestBody(JSON_MEDIA)).build()).execute().use { it.code to it.body?.string().orEmpty() } }
        catch (_: IOException) { throw VanSyncFailure("offline",true) }
    }
}
class VanSyncClient(private val transport: VanTransport, private val signer: DeviceSigner, private val deviceId: String) : VanGateway {
    override suspend fun bootstrap(): String = withContext(Dispatchers.IO) {
        send("/van/v1/bootstrap",VanBootstrapCodec.bootstrapRequest(deviceId)).also { VanBootstrapCodec.decode(it) }
    }
    override suspend fun push(operations: List<OutboxRow>): List<PushResult> = withContext(Dispatchers.IO) {
        VanBootstrapCodec.pushResults(send("/van/v1/push",VanBootstrapCodec.pushRequest(deviceId,operations.map { it.operationJson })))
    }
    override suspend fun evidence(sha256: String, jpeg: ByteArray): Unit = withContext(Dispatchers.IO) {
        VanEvidenceCodec.response(send("/van/v1/evidence",VanEvidenceCodec.request(deviceId,sha256,jpeg)),sha256)
    }
    private fun send(path: String, body: ByteArray): String {
        for (attempt in 0..1) {
            val bearer = transport.token(attempt > 0)
            val (nonce,expiresAt) = transport.challenge(deviceId) // fresh for EVERY HTTP attempt
            val timestamp = expiresAt - 30_000L // server-derived midpoint, never handset wall clock
            val result = transport.post(path,body,RequestSigner.headers(signer,deviceId,path,body,nonce,timestamp),bearer)
            if (result.first == 401 && attempt == 0) continue
            if (result.first in 200..299) return result.second
            throw error(result.first,result.second)
        }
        throw VanSyncFailure("unauthorized",false)
    }
    companion object {
        fun error(status: Int, text: String): VanSyncFailure {
            val o = runCatching { JSONObject(text).also { require(it.optString("type") == "error.response" && it.optInt("contractVersion") == 1) } }.getOrNull()
            val details = o?.optJSONObject("error") ?: o
            val code = details?.optString("code")?.takeIf { it in setOf("version_unsupported","unauthorized","invalid_request","temporarily_unavailable") }
                ?: if (status == 401) "unauthorized" else if (status >= 500 || status == 429) "temporarily_unavailable" else "invalid_request"
            return VanSyncFailure(code,details?.optBoolean("retryable") == true || status >= 500 || status == 429)
        }
    }
}
