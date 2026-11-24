package com.sunpride.field.ui

import okhttp3.CookieJar
import okhttp3.OkHttpClient
import okhttp3.Request
import java.net.URI
import java.util.concurrent.TimeUnit

/** A failed check leaves saved work usable; only a verified minimum-version policy can require an update. */
class FieldUpdateClient(origin: String, private val packageName: String, private val installed: Int,
    private val read: () -> String?, private val save: (String) -> Unit,
    private val http: OkHttpClient = OkHttpClient.Builder().cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false).followSslRedirects(false).callTimeout(5, TimeUnit.SECONDS).build()) {
    private val endpoint: String
    init {
        val u = URI(origin)
        require(u.rawUserInfo == null && u.rawQuery == null && u.rawFragment == null && u.rawPath in listOf("", "/") &&
            (u.scheme == "https" || u.scheme == "http" && u.host in setOf("127.0.0.1", "localhost")))
        require(Regex("com\\.sunpride\\.field\\.(dev|beta|staging|prod)").matches(packageName))
        endpoint = origin.trimEnd('/') + "/api/v1/apps/latest?app=field&packageName=$packageName"
    }
    fun cached(): FieldUpdateInfo? = runCatching { read()?.let { FieldUpdateInfo.decode(it, packageName, installed) } }.getOrNull()
    fun check(): FieldUpdateInfo? {
        val raw = http.newCall(Request.Builder().url(endpoint).build()).execute().use { response ->
            check(response.isSuccessful)
            val source = checkNotNull(response.body).source()
            source.request(16_385); require(source.buffer.size <= 16_384)
            source.readUtf8()
        }
        val info = FieldUpdateInfo.decode(raw, packageName, installed)
        save(raw) // Persist an explicit withdrawal/no-update too; do not retain a stale required notice.
        return info
    }
}
