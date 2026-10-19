package com.sunpride.field.auth

import org.json.JSONObject
import java.util.UUID

/** Independent cache grants: denial retires every filter before any fallible row deletion.
 * A request ticket fences both writes and fallback after A → B → A / sign-out / scope renewal.
 */
class ProjectionGrant(private val account: String, private val projection: String,
    private val get: (String) -> String?, private val put: (String, String) -> Boolean) {
    private val root = "$account|$projection"
    private var ticket: Long = 0
    private var key = ""
    private var epoch = 0L
    fun begin(filter: String) = synchronized(states) {
        key = filter
        val s = states.getOrPut(root) { State() }
        epoch = lifetime
        ticket = ++s.sequence
    }
    fun read(text: String): String? = synchronized(states) {
        if (!current()) return null
        val o = runCatching { JSONObject(text) }.getOrNull() ?: return null
        val grant = get("$root|$key") ?: return null
        if (o.optString("grant") != grant || o.optString("denialEpoch") != (get("$root|denial") ?: "")) return null
        o.optString("data").takeIf { it.isNotBlank() }
    }
    fun wrap(text: String): String? = synchronized(states) {
        if (!current()) return null
        val token = UUID.randomUUID().toString()
        if (!put("$root|$key", token)) { deny(); return null }
        JSONObject().put("data", text).put("grant", token)
            .put("denialEpoch", get("$root|denial") ?: "").toString()
    }
    fun deny(): Boolean = synchronized(states) {
        val s = states.getOrPut(root) { State() }
        // Do not let an old request revoke a newer success, either.
        if (epoch != lifetime || s.sequence != ticket) return@synchronized true
        s.sequence++; s.denied = true
        val durable = put("$root|denial", UUID.randomUUID().toString())
        if (durable) s.denied = false
        durable
    }
    fun current() = epoch == lifetime && states[root]?.let { !it.denied && it.sequence == ticket } == true
    companion object {
        private class State(var sequence: Long = 0, var denied: Boolean = false)
        private val states = mutableMapOf<String, State>()
        private var lifetime = 0L
        fun retire() = synchronized(states) { lifetime++; states.clear() }
    }
}
