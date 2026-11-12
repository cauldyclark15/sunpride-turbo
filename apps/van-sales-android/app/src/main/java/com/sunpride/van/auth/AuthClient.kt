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
    private val deviceKey: () -> JSONObject? = { null }
) {
    private var access: String? = null
    private var refreshAt = 0L
    val isSignedIn: Boolean get() = vault.readSession() != null

    @Synchronized fun signIn(email: String, password: String) {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val body = JSONObject().put("version",2).put("app",RestDeviceApi.APP).put("email",email.trim()).put("password",password)
            .put("integrity",com.sunpride.integrity.DeviceIntegrity.report())
        deviceKey()?.let { body.put("deviceKey",it) }
        val request = Request.Builder().url(environment.siteUrl.trimEnd('/')+SIGN_IN).post(body.toString().toRequestBody(JSON_MEDIA)).build()
        val o = call(request) { code, response ->
            when {
                code == 400 || code == 401 -> throw AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)
                code == 403 -> throw AuthFailure(AuthFailure.Kind.REFUSED)
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
        val request = Request.Builder().url(environment.siteUrl.trimEnd('/')+REFRESH).header("Authorization","Bearer $session")
            .post(body.toString().toRequestBody(JSON_MEDIA)).build()
        val o = call(request) { code, response ->
            // VAN-086: a paused phone keeps its session (the office may reinstate it); only an ended session signs out.
            if (code == 403 && AuthFailure.paused(response.body?.string())) throw AuthFailure(AuthFailure.Kind.PAUSED)
            if (code == 401 || code == 403) { vault.wipe(); throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED) }
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
    }
    @Synchronized fun invalidateAccessToken() { access = null; refreshAt = 0 }
    fun signOut(): Boolean {
        val session = vault.readSession()
        invalidateAccessToken(); vault.wipe() // local lockout precedes any network attempt
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
    companion object {
        const val SIGN_IN = "/api/auth/sign-in"
        const val REFRESH = "/api/auth/refresh"
        const val SIGN_OUT = "/api/auth/sign-out"
        const val MAX_SESSION_TOKEN_LENGTH = 4096
        const val REFRESH_MARGIN_MS = 60_000L
        const val DEFAULT_LIFETIME_MS = 15*60_000L
    }
}
