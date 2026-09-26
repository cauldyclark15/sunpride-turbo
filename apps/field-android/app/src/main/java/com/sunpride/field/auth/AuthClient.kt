package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
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

fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
    .cookieJar(CookieJar.NO_COOKIES) // Set-Cookie is not an auth source or persisted by OkHttp
    .followRedirects(false) // a redirect must never carry the bearer to another host
    .followSslRedirects(false)
    .connectTimeout(15, TimeUnit.SECONDS)
    .readTimeout(20, TimeUnit.SECONDS)
    .callTimeout(30, TimeUnit.SECONDS)
    .build()

/**
 * Better Auth session (persisted in [vault]) and the short-lived Convex JWT (memory only).
 * Wire, verified on DEV: sign-in POST without any Origin header returns a top-level JSON `token`
 * and Set-Cookie but no `set-auth-token` header. Prefer that header when available, otherwise
 * use the body token; exchange the session bearer at GET `/api/auth/convex/token` for the
 * short-lived Convex JWT (15-minute `aud=convex`). Cookies are not retained.
 * Blocking; call off the main thread.
 */
class AuthClient(
    private val environment: AppEnvironment,
    private val vault: SessionVault,
    private val http: OkHttpClient = defaultHttpClient(),
    private val clock: () -> Long = System::currentTimeMillis
) {
    private var jwt: String? = null
    private var jwtRefreshAt = 0L

    val isSignedIn: Boolean get() = vault.readSession() != null

    fun signIn(email: String, password: String) {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val body = JSONObject().put("email", email.trim()).put("password", password).toString()
        // OkHttp adds no Origin header; never add one (literal "null" is rejected, a web origin is forgery).
        val request = Request.Builder().url(environment.siteUrl.trimEnd('/') + SIGN_IN)
            .post(body.toRequestBody(JSON_MEDIA)).build()
        val session = call(request) { code, response ->
            when {
                code == 400 || code == 401 -> throw AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)
                code == 403 -> throw AuthFailure(AuthFailure.Kind.REFUSED)
                code == 429 -> throw AuthFailure(AuthFailure.Kind.RATE_LIMITED)
                code !in 200..299 -> throw AuthFailure(AuthFailure.Kind.SERVER)
            }
            val token = response.header(SESSION_HEADER)
                ?: (JSONObject(response.body?.string().orEmpty()).opt("token") as? String)
            token?.takeIf { it.length in 1..MAX_SESSION_TOKEN_LENGTH &&
                it.none { char -> char.isWhitespace() || char.isISOControl() } }
                ?: throw AuthFailure(AuthFailure.Kind.SERVER)
        }
        synchronized(this) { jwt = null; jwtRefreshAt = 0 }
        vault.saveSession(session)
    }

    /** Current Convex JWT, refreshed from the session a minute before `exp` or when [forceRefresh]. */
    @Synchronized fun convexToken(forceRefresh: Boolean = false): String {
        val cached = jwt
        if (!forceRefresh && cached != null && clock() < jwtRefreshAt) return cached
        jwt = null
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val session = vault.readSession() ?: throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
        val request = Request.Builder().url(environment.siteUrl.trimEnd('/') + CONVEX_TOKEN)
            .header("Authorization", "Bearer $session").get().build()
        val token = call(request) { code, response ->
            if (code == 401 || code == 403) {
                vault.wipe() // Better Auth rejected the session: it is dead, sign in again
                throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
            }
            if (code !in 200..299) throw AuthFailure(AuthFailure.Kind.SERVER)
            JSONObject(response.body?.string().orEmpty()).optString("token").takeIf { it.count { c -> c == '.' } == 2 }
                ?: throw AuthFailure(AuthFailure.Kind.SERVER)
        }
        val now = clock()
        val expiresAt = expiryMillis(token) ?: (now + DEFAULT_LIFETIME_MS)
        jwt = token
        jwtRefreshAt = maxOf(now, expiresAt - REFRESH_MARGIN_MS)
        return token
    }

    @Synchronized fun invalidateConvexToken() { jwt = null; jwtRefreshAt = 0 }

    /** Best-effort server sign-out; local wipe is unconditional. Returns whether the server confirmed. */
    fun signOut(): Boolean {
        val session = vault.readSession()
        var remote = false
        try {
            if (session != null && environment.isReady) {
                val request = Request.Builder().url(environment.siteUrl.trimEnd('/') + SIGN_OUT)
                    .header("Authorization", "Bearer $session").post("{}".toRequestBody(JSON_MEDIA)).build()
                remote = call(request) { code, _ -> code in 200..299 }
            }
        } catch (_: AuthFailure) {
            // offline/server error: remote invalidation not confirmed, local state still wiped
        } finally {
            invalidateConvexToken()
            vault.wipe()
        }
        return remote
    }

    private fun <T> call(request: Request, handle: (Int, okhttp3.Response) -> T): T = try {
        http.newCall(request).execute().use { handle(it.code, it) }
    } catch (_: IOException) {
        throw AuthFailure(AuthFailure.Kind.OFFLINE)
    } catch (_: JSONException) {
        throw AuthFailure(AuthFailure.Kind.SERVER)
    }

    companion object {
        const val SIGN_IN = "/api/auth/sign-in/email"
        const val CONVEX_TOKEN = "/api/auth/convex/token"
        const val SIGN_OUT = "/api/auth/sign-out"
        const val SESSION_HEADER = "set-auth-token"
        const val MAX_SESSION_TOKEN_LENGTH = 4096
        const val REFRESH_MARGIN_MS = 60_000L
        const val DEFAULT_LIFETIME_MS = 15 * 60_000L

        /** `exp` claim of a JWT in epoch ms (no signature check: the server verifies it). */
        fun expiryMillis(token: String): Long? = try {
            val payload = token.split('.')[1]
            val claims = JSONObject(String(Base64.getUrlDecoder().decode(payload), Charsets.UTF_8))
            if (claims.has("exp")) claims.getLong("exp") * 1000 else null
        } catch (_: Exception) { null }
    }
}
