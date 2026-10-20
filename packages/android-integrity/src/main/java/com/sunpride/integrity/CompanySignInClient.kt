package com.sunpride.integrity

import okhttp3.CookieJar
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class CompanyProvider(val code: String, val label: String)
data class CompanySignInRequest(val id: String, val secret: String, val url: String)

/** F-007: browser handles company credentials; only this install can redeem its request. */
class CompanySignInClient(private val origin: String, private val app: String,
    private val key: () -> JSONObject, private val sign: (String) -> String,
    private val http: OkHttpClient = OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).callTimeout(20, TimeUnit.SECONDS).build()) {
    fun providers(): List<CompanyProvider> {
        val rows = call("/api/auth/oidc/providers").getJSONArray("providers")
        require(rows.length() <= 100) { "Too many company sign-in providers. Ask the office to review setup." }
        return (0 until rows.length()).map { rows.getJSONObject(it).let { row -> CompanyProvider(row.getString("code"),row.getString("label")) } }
    }
    fun start(provider: String): CompanySignInRequest {
        val r = call("/api/auth/oidc/native/start",JSONObject().put("version",2).put("app",app).put("provider",provider)
            .put("deviceKey",key()).put("integrity",DeviceIntegrity.report()))
        val url = java.net.URI(r.getString("authorizationUrl"))
        require(url.scheme == "https" || url.scheme == "http" && url.host in setOf("127.0.0.1","localhost")) { "Company sign-in requires a secure browser address." }
        require(url.rawUserInfo == null && url.path == "/api/auth/oidc/start") { "Invalid company sign-in address." }
        return CompanySignInRequest(r.getString("requestId"),r.getString("pollSecret"),url.toString())
    }
    fun poll(r: CompanySignInRequest): JSONObject? {
        val response = call("/api/auth/oidc/native/poll",JSONObject().put("version",2).put("requestId",r.id).put("pollSecret",r.secret)
            .put("signature",sign("SSO|${r.id}|${r.secret}")))
        return when (response.getString("status")) { "waiting" -> null; "signed_in" -> response; else -> error("Company sign-in could not be completed.") }
    }
    private fun call(path: String, body: JSONObject? = null): JSONObject {
        val request = Request.Builder().url(origin.trimEnd('/')+path)
            .apply { if (body != null) post(body.toString().toRequestBody("application/json".toMediaType())) }.build()
        return http.newCall(request).execute().use { response ->
            val source = checkNotNull(response.body).source()
            source.request(128_001)
            require(source.buffer.size <= 128_000) { "Company sign-in returned an invalid response." }
            val raw = source.readUtf8()
            check(response.isSuccessful) { if(response.code == 403) "Company sign-in expired or access changed. Start again." else "Could not contact company sign-in. Try again when online." }
            JSONObject(raw)
        }
    }
}
