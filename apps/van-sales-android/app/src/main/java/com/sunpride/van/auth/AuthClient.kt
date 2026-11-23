package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

internal val JSON_MEDIA = "application/json".toMediaType()
fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .cookieJar(CookieJar.NO_COOKIES).followRedirects(false).followSslRedirects(false)
    .connectTimeout(15,TimeUnit.SECONDS).readTimeout(20,TimeUnit.SECONDS).callTimeout(30,TimeUnit.SECONDS).build()

/** Opaque v2 session in the existing encrypted vault; access bearer stays in memory. */
class AuthClient(
    private val environment: AppEnvironment,
    private val vault: SessionVault,
    private val http: OkHttpClient = defaultHttpClient(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val deviceKey: () -> JSONObject? = { null },
    private val phoneHeaders: () -> Map<String, String> = { com.sunpride.integrity.PhoneHardware.headers() }
) {
    private var access: String? = null
    private var refreshAt = 0L
    val isSignedIn: Boolean get() = vault.readSession() != null
    /**
     * SP-0187: the office reset this password; a new one must be set before any selling or sync.
     * Memory only: after a restart `/api/me` or any 403 `password_change_required` raises it again.
     */
    private val mustChange = kotlinx.coroutines.flow.MutableStateFlow(false)
    val passwordChangeRequired: kotlinx.coroutines.flow.StateFlow<Boolean> get() = mustChange
    /** The temporary password just typed at sign-in. Memory only (never disk); cleared once used or on sign-out. */
    @Volatile private var temporary: String? = null
    val hasTemporaryPassword: Boolean get() = temporary != null
    fun markPasswordChangeRequired() { mustChange.value = true }
    /** True (and the flag raised) when a refusal body is the server's `password_change_required`. */
    fun notePasswordChangeRefusal(status: Int, body: String?): Boolean {
        if (status != 403 || errorCode(body) != PASSWORD_CHANGE_REQUIRED) return false
        markPasswordChangeRequired(); return true
    }

    @Synchronized fun signIn(email: String, password: String) {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val body = JSONObject().put("version",2).put("app",RestDeviceApi.APP).put("email",email.trim()).put("password",password)
            .put("passwordChange","supported") // SP-0187: this build can show the Set a new password screen
            .put("integrity",com.sunpride.integrity.DeviceIntegrity.report())
        deviceKey()?.let { body.put("deviceKey",it) }
        val request = Request.Builder().url(environment.siteUrl.trimEnd('/')+SIGN_IN)
            .apply { phoneHeaders().forEach { (k,v) -> header(k,v) } }.post(body.toString().toRequestBody(JSON_MEDIA)).build()
        val o = call(request) { code, response ->
            when {
                code == 400 || code == 401 -> {
                    val reason = errorCode(response.body?.string())
                    throw AuthFailure(if (reason == "temporary_password_expired") AuthFailure.Kind.TEMPORARY_PASSWORD_EXPIRED else AuthFailure.Kind.INVALID_CREDENTIALS)
                }
                // FLD-014/E2E-004 parity: the office revoked this phone; the refusal says so plainly (no session is stored).
                code == 403 -> {
                    val reason = errorCode(response.body?.string())
                    if (reason == PASSWORD_CHANGE_REQUIRED) throw AuthFailure(AuthFailure.Kind.PASSWORD_CHANGE_ON_WEB)
                    throw AuthFailure(AuthFailure.Kind.REFUSED, removed = reason == "device_revoked")
                }
                code == 429 -> throw AuthFailure(AuthFailure.Kind.RATE_LIMITED)
                code !in 200..299 -> throw AuthFailure(AuthFailure.Kind.SERVER)
            }
            JSONObject(response.body?.string().orEmpty())
        }
        val session = token(o,"sessionToken")
        if (o.optInt("version") != 2 || o.getLong("sessionExpiresAt") <= o.getLong("serverTime")) throw AuthFailure(AuthFailure.Kind.SERVER)
        val bearer = token(o,"accessToken"); val lifetime = lifetime(o)
        vault.saveSession(session) // validate everything before changing durable credentials
        access = bearer; refreshAt = clock()+lifetime-REFRESH_MARGIN_MS
        val forced = o.optBoolean("mustChangePassword",false)
        temporary = if (forced) password else null
        mustChange.value = forced
    }
    /** F-007: no browser cookie/token is retained; only the install-bound API exchange. */
    @Synchronized fun acceptCompanySession(o: JSONObject) {
        val session=token(o,"sessionToken"); val bearer=token(o,"accessToken"); val duration=lifetime(o)
        if(o.optString("status") != "signed_in" || !session.startsWith("sps_") || !bearer.startsWith("spa_") || o.getLong("sessionExpiresAt") <= o.getLong("serverTime")) throw AuthFailure(AuthFailure.Kind.SERVER)
        invalidateAccessToken(); vault.saveSession(session); access=bearer; refreshAt=clock()+duration-REFRESH_MARGIN_MS
    }
    @Synchronized fun accessToken(forceRefresh: Boolean = false): String {
        if (vault.readSession() == null) { invalidateAccessToken(); throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED) }
        if (!forceRefresh && access != null && clock() < refreshAt) return access!!
        invalidateAccessToken()
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val session = vault.readSession() ?: throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        val body = JSONObject().put("version",2).put("app",RestDeviceApi.APP)
            .put("integrity",com.sunpride.integrity.DeviceIntegrity.report())
        deviceKey()?.optString("keyId")?.let { body.put("deviceKeyId",it) }
        val request = Request.Builder().url(environment.siteUrl.trimEnd('/')+REFRESH)
            .apply { phoneHeaders().forEach { (k,v) -> header(k,v) } }.header("Authorization","Bearer $session")
            .post(body.toString().toRequestBody(JSON_MEDIA)).build()
        val o = call(request) { code, response ->
            // VAN-086: a paused phone keeps its session (the office may reinstate it); only an ended session signs out.
            // FLD-014/171: on an ended session only the credential goes; held work stays. Say plainly when the office removed the phone.
            val text = if (code == 401 || code == 403) response.body?.string() else null
            if (code == 403 && AuthFailure.paused(text)) throw AuthFailure(AuthFailure.Kind.PAUSED)
            // SP-0187: a reset password is not an ended session; keep the session and ask for a new password.
            if (notePasswordChangeRefusal(code,text)) throw AuthFailure(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED)
            if (code == 401 || code == 403) {
                val reason = runCatching { JSONObject(text.orEmpty()).optJSONObject("error")?.optString("code") }.getOrNull()
                vault.wipe(); throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED, removed = reason in AuthFailure.REMOVED_CODES)
            }
            if (code !in 200..299) throw AuthFailure(AuthFailure.Kind.SERVER)
            JSONObject(response.body?.string().orEmpty())
        }
        val bearer = token(o,"accessToken"); val duration = lifetime(o)
        access = bearer; refreshAt = clock()+duration-REFRESH_MARGIN_MS
        return bearer
    }
    @Synchronized fun changePassword(current: String, next: String, confirm: String) {
        PasswordChange.problem(current,next,confirm)?.let { throw PasswordChangeFailure(it) }
        if (vault.readSession() == null) throw PasswordChangeFailure(PasswordProblem.SESSION)
        if (!environment.isReady) throw PasswordChangeFailure(PasswordProblem.SERVER)
        val body = JSONObject().put("currentPassword",current).put("newPassword",next)
        try {
            // Ordinary authenticated routes take the short-lived ACCESS bearer, not the refresh session token.
            val request = Request.Builder().url(environment.siteUrl.trimEnd('/')+"/api/auth/change-password")
                .header("Authorization","Bearer ${accessToken()}").post(body.toString().toRequestBody(JSON_MEDIA)).build()
            call(request) { code, response ->
                if (code !in 200..299) {
                    val error = runCatching { JSONObject(response.body?.string().orEmpty()).optJSONObject("error")?.optString("code") }.getOrNull()
                    throw PasswordChangeFailure(when {
                        code == 401 || code == 403 -> PasswordProblem.SESSION
                        code == 429 -> PasswordProblem.RATE_LIMITED
                        error == "wrong_password" -> PasswordProblem.WRONG
                        error == "weak_password" -> PasswordProblem.WEAK
                        error == "same_password" -> PasswordProblem.SAME
                        else -> PasswordProblem.SERVER
                    })
                }
                if (!JSONObject(response.body?.string().orEmpty()).optBoolean("ok")) throw PasswordChangeFailure(PasswordProblem.SERVER)
            }
        } catch (e: AuthFailure) { throw PasswordChangeFailure(when(e.kind) {
            AuthFailure.Kind.OFFLINE -> PasswordProblem.OFFLINE
            AuthFailure.Kind.SESSION_EXPIRED, AuthFailure.Kind.REFUSED -> PasswordProblem.SESSION
            else -> PasswordProblem.SERVER
        }) }
        // The server keeps this exact session; other sessions are revoked. Never replace or persist a password.
        invalidateAccessToken()
        temporary = null; mustChange.value = false
    }
    /** SP-0187: the forced change; [current] defaults to the temporary password kept in memory since sign-in. */
    @Synchronized fun setNewPassword(current: String?, next: String, confirm: String) =
        changePassword(current?.takeIf { it.isNotEmpty() } ?: temporary.orEmpty(),next,confirm)
    @Synchronized fun invalidateAccessToken() { access = null; refreshAt = 0 }
    fun signOut(): Boolean {
        val session = vault.readSession()
        invalidateAccessToken(); vault.wipe() // local lockout precedes any network attempt
        temporary = null; mustChange.value = false
        return try {
            if (session == null || !environment.isReady) false else {
                val request = Request.Builder().url(environment.siteUrl.trimEnd('/')+SIGN_OUT).header("Authorization","Bearer $session")
                    .post("{\"version\":2}".toRequestBody(JSON_MEDIA)).build()
                call(request) { code, _ -> code in 200..299 }
            }
        } catch (_: AuthFailure) { false }
    }
    private fun token(o: JSONObject, name: String): String = (o.opt(name) as? String)?.takeIf {
        it.length in 1..MAX_SESSION_TOKEN_LENGTH && it.none { c -> c.isWhitespace() || c.isISOControl() }
    } ?: throw AuthFailure(AuthFailure.Kind.SERVER)
    private fun lifetime(o: JSONObject): Long {
        if (o.optInt("version") != 2) throw AuthFailure(AuthFailure.Kind.SERVER)
        val ttl = o.getLong("accessExpiresAt")-o.getLong("serverTime")
        if (ttl !in 1..DEFAULT_LIFETIME_MS) throw AuthFailure(AuthFailure.Kind.SERVER)
        return ttl
    }
    private fun <T> call(request: Request, handle: (Int, okhttp3.Response) -> T): T = try {
        http.newCall(request).execute().use { handle(it.code,it) }
    } catch (_: IOException) { throw AuthFailure(AuthFailure.Kind.OFFLINE) }
      catch (_: JSONException) { throw AuthFailure(AuthFailure.Kind.SERVER) }
    private fun errorCode(body: String?): String? = runCatching {
        val o = JSONObject(body.orEmpty())
        o.optJSONObject("error")?.optString("code")?.takeIf { it.isNotEmpty() }
            ?: (o.opt("error") as? String)?.takeIf { it.isNotEmpty() } ?: o.optString("code").takeIf { it.isNotEmpty() }
    }.getOrNull()
    companion object {
        const val PASSWORD_CHANGE_REQUIRED = "password_change_required"
        /** `<web base>/forgot-password`, derived from the configured server origin. */
        fun forgotPasswordUrl(siteUrl: String): String = siteUrl.trim().trimEnd('/')+"/forgot-password"
        const val SIGN_IN = "/api/auth/sign-in"
        const val REFRESH = "/api/auth/refresh"
        const val SIGN_OUT = "/api/auth/sign-out"
        const val MAX_SESSION_TOKEN_LENGTH = 4096
        const val REFRESH_MARGIN_MS = 60_000L
        const val DEFAULT_LIFETIME_MS = 15*60_000L
    }
}
