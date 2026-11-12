package com.sunpride.field.auth

/**
 * User-facing failure. Messages are fixed strings: no server text, URL, token, password or proof
 * ever enters them, and no cause is attached (an IOException message could echo request details).
 */
class AuthFailure(val kind: Kind, val retryAfterMs: Long? = null, val removed: Boolean = false) :
    Exception(if (removed) PHONE_REMOVED else text(kind, retryAfterMs), null) {
    /**
     * What the person sees. FLD-004: a throttle names the real wait from the server's `retryAfterMs`.
     * FLD-014: an ended session whose phone the office revoked/paused says so plainly (kind stays SESSION_EXPIRED).
     */
    val text: String get() = if (removed) PHONE_REMOVED else text(kind, retryAfterMs)
    enum class Kind(val message: String) {
        INVALID_CREDENTIALS("Incorrect email or password."),
        REFUSED("Sign-in was refused for this account. Ask your administrator."),
        // Sign-in allows 10 tries per 5 minutes (server SIGNIN_POLICY); without a server wait, never understate it.
        RATE_LIMITED("Too many attempts. Wait up to 5 minutes and try again."),
        OFFLINE("You're offline. Check your connection and try again."),
        SESSION_EXPIRED("Your session has ended. Sign in again."),
        SERVER("The server couldn't complete the request. Try again shortly."),
        NOT_CONFIGURED("This build has no server configured.")
    }
    override fun toString(): String = "AuthFailure($kind)"
    companion object {
        /** FLD-014: unsent work is never deleted; it stays encrypted on the phone for the office's recovery/handover. */
        const val PHONE_REMOVED = "This phone was removed by the office. Your unsent work is kept on this phone. " +
            "Give the phone to your supervisor so the office can recover it."
        /** Server codes on a refused refresh that mean the office removed or paused this phone. */
        val REMOVED_CODES = setOf("device_revoked", "device_suspended")
        fun text(kind: Kind, retryAfterMs: Long?): String {
            if (kind != Kind.RATE_LIMITED || retryAfterMs == null || retryAfterMs <= 0) return kind.message
            val minutes = (retryAfterMs + 59_999) / 60_000
            return if (minutes <= 1) "Too many attempts. Try again in 1 minute."
            else "Too many attempts. Try again in $minutes minutes."
        }
        /** Reads `retryAfterMs` from a v2 (`error.retryAfterMs`) or flat 429 body; null when absent or invalid. */
        fun retryAfter(body: String?): Long? = runCatching {
            val o = org.json.JSONObject(body.orEmpty())
            val v = (o.optJSONObject("error") ?: o).opt("retryAfterMs")
            (v as? Number)?.toLong()?.takeIf { it in 1..86_400_000L }
        }.getOrNull()
    }
}

/**
 * The Sunpride server refused a request with a closed error `code` (for example `scope_withdrawn`);
 * it is kept for branching, never shown verbatim to the user.
 */
class ServerError(val code: String?) : Exception("Server error", null) {
    override fun toString(): String = "ServerError"
}
