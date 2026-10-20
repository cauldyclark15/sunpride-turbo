package com.sunpride.van.sync

import com.sunpride.van.AppEnvironment
import com.sunpride.van.auth.*
import com.sunpride.van.data.*
import com.sunpride.van.device.*
import com.sunpride.van.storage.OutboxRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.LocalDate
import java.time.ZoneId

class VanSyncFailure(val code: String, val retryable: Boolean) : Exception("Van sync: $code", null)
interface VanGateway {
    suspend fun evidence(sha256: String, jpeg: ByteArray) { throw VanSyncFailure("temporarily_unavailable",true) }
    suspend fun bootstrap(): String
    suspend fun push(operations: List<OutboxRow>): List<PushResult>
    suspend fun location(pings: List<String>): List<com.sunpride.van.location.LocationPingCodec.Result> { throw VanSyncFailure("temporarily_unavailable",true) }
}
interface VanTransport {
    fun token(refresh: Boolean): String
    fun challenge(deviceId: String): Pair<String,Long>
    fun post(path: String, body: ByteArray, headers: Map<String,String>, bearer: String): Pair<Int,String>
    fun upload(url: String, jpeg: ByteArray, capability: String): Pair<Int,String> { throw VanSyncFailure("temporarily_unavailable",true) }
}
class LiveVanTransport(private val environment: AppEnvironment, private val auth: AuthClient,
    api: NativeApi, private val http: OkHttpClient = defaultHttpClient()) : VanTransport {
    private val devices = RestDeviceApi(api)
    override fun token(refresh: Boolean) = auth.accessToken(refresh)
    override fun challenge(deviceId: String) = devices.challenge(deviceId)
    override fun post(path: String, body: ByteArray, headers: Map<String,String>, bearer: String): Pair<Int,String> {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val builder = Request.Builder().url(environment.siteUrl.trimEnd('/')+path).header("Authorization","Bearer $bearer")
        headers.forEach { (k,v) -> builder.header(k,v) }
        return execute(builder.post(body.toRequestBody(JSON_MEDIA)).build())
    }
    override fun upload(url: String, jpeg: ByteArray, capability: String): Pair<Int,String> {
        // Never send even an upload capability to another origin or a redirect.
        val expected = java.net.URI(environment.siteUrl)
        val target = java.net.URI(url)
        require(target.scheme == expected.scheme && target.host == expected.host && target.port == expected.port &&
            target.userInfo == null && target.query == null && target.fragment == null && target.path.startsWith("/api/media/uploads/"))
        return execute(Request.Builder().url(url).header("Authorization","Bearer $capability")
            .put(jpeg.toRequestBody("image/jpeg".toMediaType())).build())
    }
    private fun execute(request: Request): Pair<Int,String> = try {
        http.newCall(request).execute().use { it.code to it.body?.string().orEmpty() }
    } catch (_: IOException) { throw VanSyncFailure("offline",true) }
}

/** v2 is a transport adapter: immutable local op payloads, receipts and settlement stay unchanged. */
class VanSyncClient(private val transport: VanTransport, private val signer: DeviceSigner, private val deviceId: String,
    private val identity: NativeIdentity, private val clock: () -> Long = System::currentTimeMillis) : VanGateway {
    private var tripId: String? = null
    override suspend fun bootstrap(): String = withContext(Dispatchers.IO) {
        val day = LocalDate.now(ZoneId.of("Asia/Manila")).toString()
        // The server deliberately refuses van deltas. A complete, bounded snapshot is required every cycle.
        val request = envelope().put("since",JSONObject.NULL).put("pageCursor",JSONObject.NULL).put("limit",100)
            .put("scopes",JSONArray().put(JSONObject().put("scopeId",identity.scopeId).put("projection","van.bundle")
                .put("params",JSONObject().put("serviceDate",day))))
        val response = JSONObject(send(PULL,request.toString().toByteArray()))
        val local = V2VanCodec.snapshot(response,identity,clock())
        tripId = local.optJSONObject("trip")?.getString("tripId")
        local.toString()
    }
    override suspend fun push(operations: List<OutboxRow>): List<PushResult> = withContext(Dispatchers.IO) {
        require(operations.size in 1..20)
        val ops = operations.map { row ->
            require(row.fullAuthSubject == identity.partitionSubject && row.deviceId == deviceId && row.status != "parked")
            V2VanCodec.operation(row)
        }
        val response = JSONObject(send(PUSH,envelope().put("scopeId",identity.scopeId).put("operations",JSONArray(ops)).toString().toByteArray()))
        V2VanCodec.results(response,ops)
    }
    override suspend fun location(pings: List<String>): List<com.sunpride.van.location.LocationPingCodec.Result> = withContext(Dispatchers.IO) {
        require(pings.size in 1..100)
        val ops = pings.map { text -> val p = JSONObject(text)
            JSONObject().put("clientOpId",p.getString("clientPingId")).put("opType","location.record")
                .put("clientTime",p.getLong("recordedAt")).put("dependsOn",JSONArray()).put("payload",p)
        }
        val response = JSONObject(send(PUSH,envelope().put("scopeId",identity.scopeId).put("operations",JSONArray(ops)).toString().toByteArray()))
        V2VanCodec.results(response,ops).map { com.sunpride.van.location.LocationPingCodec.Result(it.clientRequestId,
            if (it.status == "accepted") "accepted" else "rejected",it.code) }
    }
    override suspend fun evidence(sha256: String, jpeg: ByteArray): Unit = withContext(Dispatchers.IO) {
        require(sha256 == hex(sha256(jpeg)))
        val claim = envelope().put("purpose","truck-damage").put("ownerId",checkNotNull(tripId))
            .put("mime","image/jpeg").put("size",jpeg.size).put("sha256",sha256)
        val o = JSONObject(send(CLAIMS,claim.toString().toByteArray()))
        require(o.getInt("version") == 2)
        val response = transport.upload(o.getString("uploadUrl"),jpeg,o.getString("uploadToken"))
        if (response.first !in 200..299) throw error(response.first,response.second)
        val stored = JSONObject(response.second)
        if (stored.optInt("version") != 2 || stored.optString("sha256") != sha256 || stored.optString("status") != "stored" ||
            stored.optString("blobId") != o.getString("uploadId")) throw VanWireFailure()
    }
    private fun envelope() = JSONObject().put("version",2).put("app",RestDeviceApi.APP).put("deviceId",deviceId)
    private fun send(path: String, body: ByteArray): String {
        for (attempt in 0..1) {
            val bearer = transport.token(attempt > 0)
            val (nonce,expiresAt) = transport.challenge(deviceId)
            val timestamp = expiresAt-Enrollment.CHALLENGE_TTL_MS
            val response = transport.post(path,body,RequestSigner.headers(signer,deviceId,path,body,nonce,timestamp),bearer)
            if (response.first == 401 && attempt == 0) continue
            if (response.first in 200..299) return response.second
            throw error(response.first,response.second)
        }
        throw VanSyncFailure("unauthorized",false)
    }
    companion object {
        const val PULL = "/api/sync/pull"
        const val PUSH = "/api/sync/push"
        const val CLAIMS = "/api/media/claims"
        fun error(status: Int, text: String): VanSyncFailure {
            val o = runCatching { JSONObject(text).takeIf { it.optInt("version") == 2 }?.optJSONObject("error") }.getOrNull()
            val code = o?.optString("code")
            if (com.sunpride.van.BuildConfig.DEBUG) android.util.Log.w("SunprideVan","server refused: $status ${code ?: ""}")
            val mapped = when {
                status == 401 || status == 403 || code in setOf("scope_changed","scope_withdrawn","profile_unavailable","device_unavailable") -> "unauthorized"
                status == 426 || code == "version_unsupported" -> "version_unsupported"
                status == 429 || status >= 500 -> "temporarily_unavailable"
                else -> "invalid_request"
            }
            return VanSyncFailure(mapped,status >= 500 || status == 429 || o?.optBoolean("retryable") == true)
        }
    }
}

object V2VanCodec {
    val BUSINESS_OPS = setOf("trip.start","load.confirm","truck.damage","sale.record","sale.void","return.record","cash.reconcile","stock.reconcile","trip.close","call.start","call.step","call.close")
    fun operation(row: OutboxRow): JSONObject {
        require(row.kind in BUSINESS_OPS)
        val old = JSONObject(row.operationJson)
        require(old.getString("kind") == row.kind && old.getString("clientRequestId") == row.clientRequestId)
        val payload = old.getJSONObject("payload")
        return JSONObject().put("clientOpId",row.clientRequestId).put("opType",row.kind).put("payload",payload)
            .put("clientTime",payload.getLong("deviceTime")).put("dependsOn",old.optJSONArray("dependsOn") ?: JSONArray())
    }
    fun results(o: JSONObject, ops: List<JSONObject>): List<PushResult> {
        if (o.optInt("version") != 2) throw VanWireFailure()
        val rs = o.getJSONArray("results")
        if (rs.length() != ops.size) throw VanWireFailure()
        return ops.mapIndexed { i, op ->
            val r = rs.getJSONObject(i)
            if (r.getString("clientOpId") != op.getString("clientOpId") || r.getString("opType") != op.getString("opType")) throw VanWireFailure()
            val status = r.getString("status")
            if (com.sunpride.van.BuildConfig.DEBUG && status !in setOf("applied","duplicate"))
                android.util.Log.w("SunprideVan","op ${op.getString("opType")} $status ${r.optString("code")}")
            if (r.optBoolean("retryable")) throw VanSyncFailure("temporarily_unavailable",true)
            val accepted = status in setOf("applied","duplicate")
            val ack = if (accepted) r.getJSONObject("ack").let { PushAck(it.getString("entityId"),
                if (it.isNull("movementId")) null else it.getString("movementId"),it.getLong("serverTime")) } else null
            PushResult(op.getString("opType"),op.getString("clientOpId"),if (accepted) "accepted" else if (r.optString("code") == "idempotency_conflict") "conflict" else "rejected",
                ack,if (accepted) null else r.optString("code").takeIf { Regex("[a-z_]{1,64}").matches(it) } ?: "unsupported_operation")
        }
    }
    fun snapshot(o: JSONObject, identity: NativeIdentity, now: Long): JSONObject {
        require(o.getInt("version") == 2 && !o.getBoolean("hasMore") && o.isNull("nextPageCursor") && o.getString("nextCursor").isNotBlank())
        val bundles = o.getJSONArray("bundles"); require(bundles.length() == 1)
        val b = bundles.getJSONObject(0)
        require(b.getString("projection") == "van.bundle" && b.getString("mode") == "snapshot" && b.getBoolean("complete") && b.getJSONArray("changes").length() == 0)
        val a = b.getJSONObject("authorization")
        if (b.getString("scopeId") != identity.scopeId || b.getString("scopeFingerprint") != identity.fingerprint || a.getString("epoch") != identity.epoch)
            throw VanSyncFailure("unauthorized",false)
        val serverTime = o.getLong("serverTime")
        val lease = b.getJSONObject("offlineLease").getLong("expiresAt")
        val expiry = a.getLong("expiresAt")
        require(lease > serverTime && expiry > serverTime)
        val data = b.getJSONObject("data")
        if (data.getJSONObject("seller").getString("profileId") != identity.profileId) throw VanSyncFailure("unauthorized",false)
        data.put("type","van.bootstrap.response").put("contractVersion",1).put("serverTime",serverTime)
        // F-006: engine additions stay in the v2 boundary; frozen v1 DTOs remain unchanged.
        val flows = JSONObject()
        val customers = data.getJSONArray("customers")
        for (i in 0 until customers.length()) {
            val customer = customers.getJSONObject(i)
            customer.optJSONObject("callFlow")?.let { flows.put(customer.getString("outletId"),com.sunpride.callflow.CallFlowEngine.validate(it)) }
            customer.remove("callFlow")
        }
        val serverCalls = data.optJSONArray("callFlowCalls") ?: JSONArray()
        data.remove("callFlowCalls")
        // The frozen DTO validator is reused inside the adapter; no v1 request goes on the network.
        VanBootstrapCodec.decode(data.toString())
        data.put("_v2",JSONObject().put("cursor",o.getString("nextCursor")).put("scopeFingerprint",identity.fingerprint)
            .put("epoch",identity.epoch).put("subject",identity.partitionSubject).put("callFlows",flows).put("callFlowCalls",serverCalls)
            .put("leaseExpiresAt",minOf(lease,expiry)).put("cacheExpiresAt",expiry))
        return data
    }
}
