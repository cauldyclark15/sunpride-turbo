package com.sunpride.van.ui

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.auth.NativeApiFailure

/**
 * SP-0130: plain words for sign-in and phone-registration failures, the same copy as the field app
 * (`FieldController.userMessage`). Fixed strings only: server text, URLs and credentials never reach
 * the screen.
 */
object AuthMessages {
    const val SIGN_IN_FALLBACK = "Couldn't sign in. Try again."
    const val CHECK_FALLBACK = "Couldn't check this phone. Try again."

    fun forFailure(e: Throwable, fallback: String): String = when (e) {
        is AuthFailure -> e.kind.message
        is NativeApiFailure -> when (e.code) {
            "device_unavailable" -> "This phone isn't available for your account. Ask your administrator."
            "scope_withdrawn" -> "Your assignment changed. Ask your administrator to re-register this phone."
            "device_revoked" -> "This phone was removed. Ask your administrator."
            "device_suspended" -> "This phone is paused. Ask your administrator."
            "device_unbound", "not_registered" -> "This phone isn't registered yet. Ask your administrator."
            "already_bound", "credential_taken" -> "This phone is registered to a different account. Ask your administrator."
            "rate_limited" -> "Too many attempts. Wait a minute and try again."
            else -> "Couldn't verify this phone. Try again."
        }
        else -> fallback
    }
}
