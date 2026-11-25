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
    @Synchronized fun runSession(exchange: (String, JSONArray) -> JSONObject, readSession: () -> String?,
        readReceipt: () -> String?, saveReceipt: (String?) -> Unit, apply: (String) -> Unit): Boolean {
        fun pending(): List<JSONObject> {
            val raw = readReceipt() ?: return emptyList()
            val list = if(raw.startsWith("[")) JSONArray(raw) else JSONArray().put(JSONObject(raw))
            require(list.length() <= 20)
            return (0 until list.length()).map { list.getJSONObject(it) }
        }
        fun save(list: List<JSONObject>) { saveReceipt(if(list.isEmpty()) null else JSONArray(list).toString()) }
        fun forget(id: String) { save(pending().filter { it.getString("id") != id }) }
        // Ended sessions are kept only in the encrypted receipt vault, never as usable sign-ins.
        // An old lost reply must neither sign out a newer session nor be overwritten by its commands.
        for (receipt in pending()) {
            val old = receipt.getString("session")
            val same = readSession() == old
            if (same) apply(receipt.getString("kind"))
            check(readSession() != old) { "Phone is still signed in" }
            runCatching {
                exchange(old, JSONArray().put(receipt.getString("id")))
                forget(receipt.getString("id"))
            }
            if (same) return true
        }
        val session = readSession() ?: return false
        var terminalId: String? = null
        return run({ acks -> exchange(session, acks) }, { readSession() == session }, apply,
            { id, kind ->
                val receipts = pending()
                check(receipts.size < 20) { "Phone receipts are still waiting" }
                save(receipts + JSONObject().put("session",session).put("id",id).put("kind",kind))
                terminalId = id
            },
            { forget(checkNotNull(terminalId)) })
    }
    fun run(exchange: (JSONArray) -> JSONObject, current: () -> Boolean, apply: (String) -> Unit,
        beforeTerminal: (String, String) -> Unit = { _, _ -> }, terminalDone: () -> Unit = {}): Boolean {
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
            val terminal = kind in setOf("sign_out", "remove")
            if (terminal) beforeTerminal(id, kind)
            check(current()) { "Sign-in changed" }
            apply(kind)
            if (terminal) {
                check(!current()) { "Phone is still signed in" }
                // Local lockout already happened. A lost reply remains in the encrypted receipt vault.
                runCatching { exchange(JSONArray().put(id)); terminalDone() }
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
