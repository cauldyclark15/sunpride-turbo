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
        is NativeApiFailure -> UserMessages.forCode(e.code) ?: "Couldn't verify this phone. Try again."
        else -> fallback
    }
}
