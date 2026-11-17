package com.sunpride.field.sell.auth

import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.auth.JSON_MEDIA
import com.sunpride.field.auth.defaultHttpClient
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/** The app id every selling request carries: a Field phone sells as itself (the server lets it when Selling is on). */
const val SELL_APP = "field-android"

/**
 * SP-0192: what the Field app lends the Sell area. Sign-in, the session, the device key and phone registration all stay
 * the Field app's; selling never signs in, registers or stores a credential of its own. Every call may block.
 */
interface SellAccess {
    val siteUrl: String
    val ready: Boolean
    val isSignedIn: Boolean
    /** Changes whenever the person signs out or another person signs in (never the session itself). */
    fun sessionKey(): String?
    /** Throws [AuthFailure] (already in the Sell area's own words). */
    fun accessToken(refresh: Boolean): String
    fun invalidateAccessToken()
    /** The registered Field phone, or null before registration. */
    fun deviceId(): String?
    fun signer(): DeviceSigner
    fun deviceKeyId(): String?
    /** A refused call said a new password is needed; the Field app opens its Set a new password screen. */
    fun passwordChangeRequired() {}
}

/** Cookie-free v2 reads and v1 commands for the Sell area, as the Van app made them, on the Field session. One refresh on 401. */
class NativeApi(private val access: SellAccess, private val http: OkHttpClient = defaultHttpClient()) {
    private val catalogueImages = com.sunpride.catalogue.CatalogueHttp(http)
    fun image(image: com.sunpride.catalogue.CatalogueImage): ByteArray? =
        if (!access.ready) null else catalogueImages.fetch(access.siteUrl, image, access::accessToken, access::invalidateAccessToken)
    fun request(path: String, body: JSONObject? = null, headers: Map<String,String> = emptyMap()): JSONObject {
        require(path.substringBefore('?') in ALLOWED)
        if (!access.ready) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        for (attempt in 0..1) {
            val builder = Request.Builder().url(access.siteUrl.trimEnd('/') + path)
                .header("Authorization", "Bearer ${access.accessToken(attempt > 0)}").header("X-App", SELL_APP)
            access.deviceKeyId()?.let { builder.header("X-Device-Key-Id", it) }
            headers.forEach { (k, v) -> builder.header(k, v) }
            if (body == null) builder.get() else builder.post(body.toString().toRequestBody(JSON_MEDIA))
            try {
                http.newCall(builder.build()).execute().use { response ->
                    if (response.code == 401) {
                        access.invalidateAccessToken()
                        if (attempt == 1) throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
                    } else {
                        val text = response.body?.string().orEmpty()
                        val o = runCatching { JSONObject(text) }.getOrNull() ?: throw AuthFailure(AuthFailure.Kind.SERVER)
                        if (response.code == 403 && AuthFailure.paused(text)) throw AuthFailure(AuthFailure.Kind.PAUSED)
                        if (response.code == 403 && o.optJSONObject("error")?.optString("code") == "password_change_required") {
                            access.passwordChangeRequired(); throw AuthFailure(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED)
                        }
                        if (response.code == 403) throw AuthFailure(AuthFailure.Kind.REFUSED)
                        if (!response.isSuccessful) {
                            val code = o.optJSONObject("error")?.optString("code")?.takeIf { Regex("[a-z_]{1,64}").matches(it) }
                            throw NativeApiFailure(code, response.code)
                        }
                        if (!path.startsWith("/api/v1/") && o.optInt("version") != 2) throw AuthFailure(AuthFailure.Kind.SERVER)
                        return o
                    }
                }
            } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        }
        throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
    }
    /** The identity the selling store is partitioned by and the registered phone, from the Field session's own `/api/me`. */
    fun identity(): Pair<NativeIdentity, String> {
        val o = request("/api/me")
        if (o.optBoolean("mustChangePassword", false)) { access.passwordChangeRequired(); throw AuthFailure(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED) }
        val p = o.getJSONObject("profile"); val s = o.getJSONObject("scope")
        if (!p.getBoolean("active")) throw AuthFailure(AuthFailure.Kind.REFUSED)
        val device = o.optJSONObject("device") ?: throw AuthFailure(AuthFailure.Kind.REFUSED)
        if (device.optString("status") != "active" || !device.optBoolean("bound")) throw AuthFailure(AuthFailure.Kind.REFUSED)
        return NativeIdentity(p.getString("subject"), p.getString("id"), s.getString("id"), s.getString("fingerprint"), s.getString("epoch")) to device.getString("id")
    }
    /** Nonce and server time for one signed request (the Field phone's own challenge). */
    fun challenge(deviceId: String): Pair<String, Long> {
        val o = request("/api/devices/challenge", JSONObject().put("version", 2).put("deviceId", deviceId)
            .put("integrity", com.sunpride.integrity.DeviceIntegrity.report()))
        val now = o.getLong("serverTime"); val expiry = o.getLong("expiresAt")
        require(expiry > now && expiry - now <= 60_000)
        return o.getString("nonce") to now
    }
    companion object {
        val ALLOWED = setOf("/api/me", "/api/devices/challenge", "/api/v1/callflow/geofence/request", "/api/v1/fiscal/overrides/request",
            "/api/v1/fiscal/overrides/status", "/api/v1/credit/check", "/api/v1/fiscal/discount-claims/preview")
    }
}

class NativeApiFailure(val code: String?, val status: Int) : Exception("Server request refused", null)

data class NativeIdentity(val subject: String, val profileId: String, val scopeId: String, val fingerprint: String, val epoch: String) {
    /** A new namespace, never a pre-v2 partition. Scope changes retain prior work held. */
    init { require(listOf(subject,profileId,scopeId,fingerprint,epoch).all { it.isNotBlank() && it.length <= 512 && it.none(Char::isISOControl) }) }
    val partitionSubject: String get() = "v2|$subject|$fingerprint"
}
