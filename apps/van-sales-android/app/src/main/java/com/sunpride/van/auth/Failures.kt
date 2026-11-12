package com.sunpride.van.auth

/**
 * User-facing failure. Messages are fixed strings: no server text, URL, token, password or proof
 * ever enters them, and no cause is attached (an IOException message could echo request details).
 */
class AuthFailure(val kind: Kind) : Exception(kind.message, null) {
    enum class Kind(val message: String) {
        INVALID_CREDENTIALS("Incorrect email or password."),
        REFUSED("Sign-in was refused for this account. Ask your administrator."),
        RATE_LIMITED("Too many attempts. Wait a minute and try again."),
        OFFLINE("You're offline. Check your connection and try again."),
        SESSION_EXPIRED("Your session has ended. Sign in again."),
        /** VAN-086: the office paused this phone; the session and the work on the phone stay until it is reinstated. */
        PAUSED("This phone is paused. Ask your administrator."),
        SERVER("The server couldn't complete the request. Try again shortly."),
        NOT_CONFIGURED("This build has no server configured.")
    }
    override fun toString(): String = "AuthFailure($kind)"
    companion object {
        /** True when a refusal body says the office paused this phone (`device_suspended`). */
        fun paused(body: String?): Boolean = runCatching {
            org.json.JSONObject(body.orEmpty()).optJSONObject("error")?.optString("code") == "device_suspended"
        }.getOrDefault(false)
    }
}
