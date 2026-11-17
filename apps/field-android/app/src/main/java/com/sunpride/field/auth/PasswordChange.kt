package com.sunpride.field.auth

/** Fixed messages only; never display a server response or retain a password. */
class PasswordChangeFailure(val kind: Kind) : Exception(kind.text) {
    enum class Kind(val text: String) {
        CURRENT_REQUIRED("Enter your current password."),
        WRONG_CURRENT("Your current password is incorrect."),
        TOO_SHORT("Use at least 8 characters for your new password."),
        TOO_LONG("Use no more than 128 characters for your new password."),
        SAME("Choose a different password from your current one."),
        MISMATCH("The new passwords do not match."),
        SERVER("Could not change your password. Try again."),
        LOCAL_SESSION("Password changed. Sign in again on this phone."),
    }
}

object PasswordChange {
    const val PATH = "/api/auth/change-password"
    /** SP-0186 server codes. */
    const val REQUIRED_CODE = "password_change_required"
    const val EXPIRED_CODE = "temporary_password_expired"
    /** SP-0186: the website's Forgot password page, on the same origin the app talks to. */
    fun forgotPasswordUrl(apiOrigin: String): String? = runCatching {
        val uri = java.net.URI(apiOrigin.trim())
        val scheme = uri.scheme?.lowercase()?.takeIf { it == "https" || it == "http" } ?: return null
        val host = uri.host ?: return null
        val port = if (uri.port == -1) "" else ":${uri.port}"
        "$scheme://$host$port/forgot-password"
    }.getOrNull()
    /** SP-0186: one process-wide record that this account must set a new password (true) or no longer must (false). */
    @Volatile var requiredSink: ((Boolean) -> Unit)? = null
    internal fun notifyRequired(required: Boolean) { runCatching { requiredSink?.invoke(required) } }
    internal fun errorCode(body: String?): String? =
        runCatching { org.json.JSONObject(body.orEmpty()).optJSONObject("error")?.optString("code") }.getOrNull()
    const val SUCCESS = "Password changed. Other devices were signed out."
    fun validate(current: String, next: String, confirm: String): PasswordChangeFailure.Kind? = when {
        current.isEmpty() -> PasswordChangeFailure.Kind.CURRENT_REQUIRED
        next.length < 8 -> PasswordChangeFailure.Kind.TOO_SHORT
        next.length > 128 -> PasswordChangeFailure.Kind.TOO_LONG
        next == current -> PasswordChangeFailure.Kind.SAME
        next != confirm -> PasswordChangeFailure.Kind.MISMATCH
        else -> null
    }
    fun error(code: String?) = when (code) {
        "wrong_password" -> PasswordChangeFailure.Kind.WRONG_CURRENT
        "weak_password" -> PasswordChangeFailure.Kind.TOO_SHORT
        "same_password" -> PasswordChangeFailure.Kind.SAME
        else -> PasswordChangeFailure.Kind.SERVER
    }
}
