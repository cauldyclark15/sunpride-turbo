package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.RequestSigner
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit

internal val JSON_MEDIA = "application/json".toMediaType()
// One cookie-free connection pool per process. Foreground sync, photos and location workers
// reuse TLS/HTTP2 connections instead of opening several clients on every backend instance.
private val sharedHttpClient: OkHttpClient by lazy {
    OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.SECONDS).build()
}
fun defaultHttpClient(): OkHttpClient = sharedHttpClient

/** Stable v2 session in the existing biometric-aware vault; opaque access credential in memory only. */
class AuthClient(private val environment: AppEnvironment, private val vault: SessionVault,
    private val http: OkHttpClient = defaultHttpClient(), private val clock: () -> Long = System::currentTimeMillis,
    private val signer: (() -> DeviceSigner)? = null) {
    private var access: String? = null
    private var refreshAt = 0L
    val isSignedIn: Boolean get() = vault.readSession()?.startsWith("sps_") == true
    fun deviceKeyId(): String? = signer?.invoke()?.let {
        RequestSigner.bodyDigest(Base64.getDecoder().decode(it.publicKeyBase64))
    }
    @Synchronized fun signIn(email: String, password: String) {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val body = JSONObject().put("version", 2).put("app", NativeApi.APP)
            .put("email", email.trim()).put("password", password)
            .put("integrity", com.sunpride.integrity.DeviceIntegrity.report())
        signer?.invoke()?.let { body.put("deviceKey", JSONObject().put("keyId", deviceKeyId())
            .put("publicKeySpki", it.publicKeyBase64)) }
        val o = exchange(SIGN_IN, body, null, signingIn = true)
        val session = credential(o, "sessionToken", "sps_")
        val token = credential(o, "accessToken", "spa_")
        val expiry = o.getLong("accessExpiresAt")
        requireExpiry(o, expiry)
        invalidateAccessToken()
        vault.saveSession(session)
        access = token; refreshAt = expiry - REFRESH_MARGIN_MS
    }
    /** The short-lived opaque access token, held in memory and refreshed from the stored session. */
    @Synchronized fun accessToken(forceRefresh: Boolean = false): String {
        access?.let { if (!forceRefresh && clock() < refreshAt && isSignedIn) return it }
        access = null
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val session = vault.readSession()?.takeIf { it.startsWith("sps_") }
            ?: throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        val o = exchange(REFRESH_PATH, JSONObject().put("version", 2).put("app", NativeApi.APP)
            .put("deviceKeyId", deviceKeyId() ?: JSONObject.NULL)
            .put("integrity", com.sunpride.integrity.DeviceIntegrity.report()), session)
        val token = credential(o, "accessToken", "spa_")
        val expiry = o.getLong("accessExpiresAt"); requireExpiry(o, expiry)
        access = token; refreshAt = expiry - REFRESH_MARGIN_MS
        return token
    }
    /** Keep this phone's session; the server revokes every other session atomically. */
    @Synchronized fun changePassword(current: String, next: String, confirm: String) {
        PasswordChange.validate(current, next, confirm)?.let { throw PasswordChangeFailure(it) }
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val session = vault.readSession()?.takeIf { it.startsWith("sps_") }
            ?: throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        for (attempt in 0..1) {
            val request = Request.Builder().url(environment.apiOrigin.trimEnd('/') + PasswordChange.PATH)
                .header("Authorization", "Bearer ${accessToken(attempt > 0)}")
                .post(JSONObject().put("currentPassword", current).put("newPassword", next)
                    .toString().toRequestBody(JSON_MEDIA)).build()
            try {
                http.newCall(request).execute().use { response ->
                    if (response.code == 401) {
                        invalidateAccessToken()
                        if (attempt == 0) return@use
                        throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
                    }
                    if (response.code == 429) throw AuthFailure(AuthFailure.Kind.RATE_LIMITED)
                    val body = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
                    if (response.code !in 200..299 || body?.optBoolean("ok") != true)
                        throw PasswordChangeFailure(PasswordChange.error(body?.optJSONObject("error")?.optString("code")))
                    // Replacing even the same token retires pending biometric callbacks and deletes the old
                    // biometric key/blob. Device binding, scope index and queued work stay unchanged.
                    try { vault.saveSession(session) }
                    catch (_: Exception) {
                        invalidateAccessToken(); runCatching { vault.wipe() }
                        throw PasswordChangeFailure(PasswordChangeFailure.Kind.LOCAL_SESSION)
                    }
                    return
                }
            } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        }
        throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
    }
    @Synchronized fun invalidateAccessToken() { access = null; refreshAt = 0 }
    fun signOut(): Boolean {
        val session = vault.readSession()
        // Local lockout precedes the fallible network request, including biometric callback retirement.
        invalidateAccessToken(); vault.wipe()
        return try {
            if (session == null || !environment.isReady) false
            else { exchange(SIGN_OUT, JSONObject().put("version", 2), session); true }
        } catch (_: AuthFailure) { false }
    }
    private fun exchange(path: String, body: JSONObject, session: String?, signingIn: Boolean = false): JSONObject {
        val request = Request.Builder().url(environment.apiOrigin.trimEnd('/') + path)
            .apply { session?.let { header("Authorization", "Bearer $it") } }
            .post(body.toString().toRequestBody(JSON_MEDIA)).build()
        return try {
            http.newCall(request).execute().use { r ->
                when {
                    signingIn && r.code in setOf(400, 401) -> throw AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)
                    !signingIn && r.code in setOf(401, 403) -> {
                        vault.wipe(); throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
                    }
                    r.code == 403 -> throw AuthFailure(AuthFailure.Kind.REFUSED)
                    r.code == 429 -> throw AuthFailure(AuthFailure.Kind.RATE_LIMITED)
                    r.code !in 200..299 -> throw AuthFailure(AuthFailure.Kind.SERVER)
                }
                JSONObject(r.body?.string().orEmpty()).also {
                    if (it.optInt("version") != 2) throw AuthFailure(AuthFailure.Kind.SERVER)
                }
            }
        } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
        catch (_: JSONException) { throw AuthFailure(AuthFailure.Kind.SERVER) }
    }
    private fun credential(o: JSONObject, name: String, prefix: String): String =
        (o.opt(name) as? String)?.takeIf { it.startsWith(prefix) && it.length in 5..MAX_SESSION_TOKEN_LENGTH &&
            it.none { c -> c.isWhitespace() || c.isISOControl() } } ?: throw AuthFailure(AuthFailure.Kind.SERVER)
    private fun requireExpiry(o: JSONObject, expiry: Long) {
        if (expiry <= o.getLong("serverTime") || expiry <= clock()) throw AuthFailure(AuthFailure.Kind.SERVER)
    }
    companion object {
        const val SIGN_IN = "/api/auth/sign-in"
        const val REFRESH_PATH = "/api/auth/refresh"
        const val SIGN_OUT = "/api/auth/sign-out"
        const val SESSION_HEADER = "set-auth-token" // legacy test fixture only; never read
        const val MAX_SESSION_TOKEN_LENGTH = 4096
        const val REFRESH_MARGIN_MS = 60_000L
        const val DEFAULT_LIFETIME_MS = 15 * 60_000L
        /** Legacy fixture utility, not used for v2 identity or access expiry. */
        fun expiryMillis(token: String): Long? = try {
            val claims = JSONObject(String(Base64.getUrlDecoder().decode(token.split('.')[1]), Charsets.UTF_8))
            if (claims.has("exp")) claims.getLong("exp") * 1000 else null
        } catch (_: Exception) { null }
    }
}
