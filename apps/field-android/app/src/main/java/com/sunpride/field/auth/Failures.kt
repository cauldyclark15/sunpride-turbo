package com.sunpride.field.auth

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
        SERVER("The server couldn't complete the request. Try again shortly."),
        NOT_CONFIGURED("This build has no server configured.")
    }
    override fun toString(): String = "AuthFailure($kind)"
}

/**
 * A Convex function returned `{status:"error"}`. [code] is the ConvexError data when it is a short
 * plain string (our backend throws fixed English codes such as "Device unavailable"); it is kept for
 * branching, never shown verbatim to the user.
 */
class ConvexFunctionError(val code: String?) : Exception("Convex function error", null) {
    override fun toString(): String = "ConvexFunctionError"
}
