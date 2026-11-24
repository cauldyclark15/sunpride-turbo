package com.sunpride.integrity

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.MediaType.Companion.toMediaType
import org.json.JSONArray
import org.json.JSONObject

/** SP-0249: an at-least-once, session-bound control channel, separate from business access.
 * Effects must be repeatable. A refused/failed effect is never acknowledged as done.
 * A terminal effect can wipe the vault: its acknowledgement uses only the captured old session.
 */
object PhoneCommands {
    const val PATH = "/api/auth/phone-check"
    const val POLL_MS = 60_000L
    val kinds = setOf("sign_out", "remove", "refresh", "resend", "update")
    fun run(exchange: (JSONArray) -> JSONObject, current: () -> Boolean, apply: (String) -> Unit): Boolean {
        val response = exchange(JSONArray())
        require(response.getInt("version") == 2)
        val commands = response.getJSONArray("commands")
        require(commands.length() <= 20)
        for (i in 0 until commands.length()) {
            check(current()) { "Sign-in changed" }
            val command = commands.getJSONObject(i)
            val id = command.getString("id")
            require(runCatching { java.util.UUID.fromString(id).toString() == id }.getOrDefault(false))
            val kind = command.getString("kind")
            if (kind !in kinds) continue // A newer command waits for an app that understands it.
            apply(kind)
            val terminal = kind in setOf("sign_out", "remove")
            if (terminal) {
                // Local lockout already happened, even if this last network request loses its reply.
                runCatching { exchange(JSONArray().put(id)) }
                return true
            }
            check(current()) { "Sign-in changed" }
            exchange(JSONArray().put(id))
        }
        return false
    }

    fun check(http: OkHttpClient, origin: String, session: String, app: String, keyId: String,
        version: String, unsent: Int, acks: JSONArray, headers: Map<String,String>): JSONObject {
        val body = JSONObject().put("version",2).put("app",app).put("keyId",keyId)
            .put("appVersion",version).put("unsentCount",unsent.coerceIn(0,1_000_000)).put("acks",acks)
        val request = Request.Builder().url(origin.trimEnd('/')+PATH)
            .header("Authorization","Bearer $session")
            .apply { headers.forEach { (k,v) -> header(k,v) } }
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        return http.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Phone check unavailable" }
            val source = checkNotNull(response.body).source()
            source.request(64_001); require(source.buffer.size <= 64_000)
            JSONObject(source.readUtf8())
        }
    }
}
