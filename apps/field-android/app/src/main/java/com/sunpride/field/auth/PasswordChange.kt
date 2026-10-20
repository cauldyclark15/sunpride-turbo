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
