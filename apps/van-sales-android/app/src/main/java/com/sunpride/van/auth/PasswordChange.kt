package com.sunpride.van.auth

/** Fixed, local wording only. Never display a server body or keep password drafts. */
class PasswordChangeFailure(val problem: PasswordProblem) : Exception(problem.words, null)
enum class PasswordProblem(val words: String) {
    CURRENT_REQUIRED("Enter your current password."),
    WEAK("Choose a password between 8 and 128 characters."),
    SAME("Choose a different password from your current one."),
    MISMATCH("The new passwords do not match."),
    WRONG("Your current password is incorrect."),
    OFFLINE("You're offline. Connect to change your password."),
    SESSION("Your session has ended. Sign in again."),
    RATE_LIMITED("Too many attempts. Wait a minute and try again."),
    SERVER("Could not change your password. Try again shortly.")
}
object PasswordChange {
    fun problem(current: String, next: String, confirm: String): PasswordProblem? = when {
        current.isEmpty() -> PasswordProblem.CURRENT_REQUIRED
        next.length !in 8..128 -> PasswordProblem.WEAK
        next == current -> PasswordProblem.SAME
        next != confirm -> PasswordProblem.MISMATCH
        else -> null
    }
}
