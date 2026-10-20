package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.RequestSigner
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/** Cookie-free v2 HTTP. Session credentials never leave AuthClient; only access tokens reach this seam. */
class NativeApi(private val environment: AppEnvironment, private val auth: AuthClient,
    private val http: OkHttpClient = defaultHttpClient()) {
    private val catalogueImages=com.sunpride.catalogue.CatalogueHttp(http)
    fun image(image:com.sunpride.catalogue.CatalogueImage):ByteArray? =
        if(!environment.isReady)null else catalogueImages.fetch(environment.apiOrigin,image,auth::accessToken,auth::invalidateAccessToken)
    var onDeviceControl: ((JSONObject) -> Unit)? = null
    fun me(): JSONObject = request("GET", "/api/me", null)
    fun post(path: String, body: JSONObject): JSONObject = request("POST", path,
        JSONObject(body.toString()).apply { if(path == "/api/devices/challenge") put("integrity",com.sunpride.integrity.DeviceIntegrity.report()) }.toString().toByteArray())
    fun get(path: String): JSONObject = request("GET", path, null)
    fun signed(path: String, body: JSONObject, signer: DeviceSigner, deviceId: String): JSONObject =
        request("POST", path, body.toString().toByteArray(Charsets.UTF_8), signer, deviceId)

    private fun request(method: String, path: String, bytes: ByteArray?, signer: DeviceSigner? = null,
        deviceId: String? = null): JSONObject {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        for (attempt in 0..1) {
            val token = auth.accessToken(attempt > 0)
            val proof = if (signer == null) emptyMap() else {
                val ch = post("/api/devices/challenge", JSONObject().put("version", 2).put("deviceId", deviceId))
                RequestSigner.headers(signer, requireNotNull(deviceId), path, requireNotNull(bytes),
                    ch.getString("nonce"), ch.getLong("serverTime"))
            }
            val request = Request.Builder().url(environment.apiOrigin.trimEnd('/') + path)
                .header("Authorization", "Bearer $token").header("X-App", APP)
                .apply { auth.deviceKeyId()?.let { header("X-Device-Key-Id", it) }; proof.forEach { (k, v) -> header(k, v) } }
                .method(method, bytes?.toRequestBody(JSON_MEDIA)).build()
            try {
                http.newCall(request).execute().use { response ->
                    if (response.code == 401) {
                        auth.invalidateAccessToken()
                        if (attempt == 1) throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
                    } else {
                        val o = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
                            ?: throw AuthFailure(AuthFailure.Kind.SERVER)
                        if (response.code !in 200..299) {
                            if (response.code == 429) throw AuthFailure(AuthFailure.Kind.RATE_LIMITED)
                            if (response.code >= 500) throw AuthFailure(AuthFailure.Kind.SERVER)
                            throw ServerError(o.optJSONObject("error")?.optString("code"))
                        }
                        if (o.optInt("version") != 2 && path.startsWith("/api/v1/").not())
                            throw AuthFailure(AuthFailure.Kind.SERVER)
                        if (path == "/api/me" && o.optJSONObject("deviceControl") != null) onDeviceControl?.invoke(o)
                        return o
                    }
                }
            } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        }
        throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
    }
    companion object { const val APP = "field-android" }
}
