package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import com.sunpride.van.device.*
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/** Cookie-free v2 reads/device commands and explicit location consent. One access refresh on 401. */
class NativeApi(private val environment: AppEnvironment, private val auth: AuthClient,
    private val http: OkHttpClient = defaultHttpClient()) {
    var onDeviceControl: ((JSONObject) -> Unit)? = null
    fun locationConsent(enabled: Boolean) {
        val o=request("/api/v1/location/consent",JSONObject().put("enabled",enabled))
        if (o.opt("enabled") != enabled || o.optLong("effectiveFrom",0) <= 0) throw AuthFailure(AuthFailure.Kind.SERVER)
    }
    fun request(path: String, body: JSONObject? = null, headers: Map<String,String> = emptyMap()): JSONObject {
        require(path in setOf("/api/me","/api/devices/challenge","/api/devices/bind","/api/v1/location/consent","/api/devices/control/recover","/api/devices/control/ack"))
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        for (attempt in 0..1) {
            val builder = Request.Builder().url(environment.siteUrl.trimEnd('/')+path)
                .header("Authorization","Bearer ${auth.accessToken(attempt > 0)}")
            headers.forEach { (k,v) -> builder.header(k,v) }
            if (body == null) builder.get() else builder.post(body.toString().toRequestBody(JSON_MEDIA))
            try {
                http.newCall(builder.build()).execute().use { response ->
                    if (response.code == 401) {
                        auth.invalidateAccessToken()
                        if (attempt == 1) throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
                    } else {
                        val o = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
                            ?: throw AuthFailure(AuthFailure.Kind.SERVER)
                        if (response.code == 403) throw AuthFailure(AuthFailure.Kind.REFUSED)
                        if (!response.isSuccessful) {
                            val code = o.optJSONObject("error")?.optString("code")?.takeIf { Regex("[a-z_]{1,64}").matches(it) }
                            throw NativeApiFailure(code, response.code)
                        }
                        if (path != "/api/v1/location/consent" && o.optInt("version") != 2) throw AuthFailure(AuthFailure.Kind.SERVER)
                        if (path == "/api/me" && o.optJSONObject("deviceControl") != null) onDeviceControl?.invoke(o)
                        return o
                    }
                }
            } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        }
        throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
    }
}

class NativeApiFailure(val code: String?, val status: Int) : Exception("Server request refused", null)

data class NativeIdentity(val subject: String, val profileId: String, val scopeId: String, val fingerprint: String, val epoch: String) {
    /** A new namespace, never a pre-v2 partition. Scope changes retain prior work held. */
    init { require(listOf(subject,profileId,scopeId,fingerprint,epoch).all { it.isNotBlank() && it.length <= 512 && it.none(Char::isISOControl) }) }
    val partitionSubject: String get() = "v2|$subject|$fingerprint"
}

class RestDeviceApi(private val api: NativeApi) : DeviceApi {
    var identity: NativeIdentity? = null
        private set
    override fun mine(publicKey: String): DeviceRecord? {
        val keyId = hex(sha256(unbase64(publicKey)))
        val o = api.request("/api/me", headers = mapOf("X-App" to APP,"X-Device-Key-Id" to keyId))
        if (o.optBoolean("handoverRequired")) throw NativeApiFailure("device_handover_required",409)
        val p = o.getJSONObject("profile"); val s = o.getJSONObject("scope")
        if (!p.getBoolean("active")) throw AuthFailure(AuthFailure.Kind.REFUSED)
        identity = NativeIdentity(p.getString("subject"),p.getString("id"),s.getString("id"),s.getString("fingerprint"),s.getString("epoch"))
        return o.optJSONObject("device")?.let { DeviceRecord(it.getString("id"),it.getString("status"),it.getBoolean("bound"),it.getString("allowedApp")) }
    }
    override fun challenge(deviceId: String): Pair<String,Long> {
        val o = api.request("/api/devices/challenge",JSONObject().put("version",2).put("deviceId",deviceId)
            .put("integrity",com.sunpride.integrity.DeviceIntegrity.report()))
        val now = o.getLong("serverTime"); val expiry = o.getLong("expiresAt")
        require(expiry > now && expiry - now <= 60_000)
        // Preserve DeviceApi's established expiry seam; enrollment derives this explicit server time.
        return o.getString("nonce") to now + Enrollment.CHALLENGE_TTL_MS
    }
    override fun bind(deviceId: String, credentialId: String, attestationFormat: String, keyId: String?, nonce: String, timestamp: Long, proof: String) {
        val o = api.request("/api/devices/bind",JSONObject().put("version",2).put("deviceId",deviceId)
            .put("credentialId",credentialId).put("attestation",JSONObject().put("format",attestationFormat).put("keyId",keyId ?: JSONObject.NULL))
            .put("nonce",nonce).put("timestamp",timestamp).put("proof",proof))
        if (o.optString("bindingStatus") != "bound") throw AuthFailure(AuthFailure.Kind.REFUSED)
    }
    companion object { const val APP = "van-android" }
}
