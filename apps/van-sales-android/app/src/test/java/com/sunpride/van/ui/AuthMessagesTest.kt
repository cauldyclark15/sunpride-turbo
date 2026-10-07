package com.sunpride.van.ui

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.auth.ConvexFunctionError
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** SP-0130: sign-in failures read as plain words, never the generic "Could not save this change". */
class AuthMessagesTest {
    private fun signIn(e: Throwable) = AuthMessages.forFailure(e,AuthMessages.SIGN_IN_FALLBACK)

    @Test fun wrongPasswordSaysIncorrectEmailOrPassword() {
        assertEquals("Incorrect email or password.",signIn(AuthFailure(AuthFailure.Kind.INVALID_CREDENTIALS)))
    }
    @Test fun everyAuthFailureUsesItsOwnPlainMessage() {
        assertEquals("You're offline. Check your connection and try again.",signIn(AuthFailure(AuthFailure.Kind.OFFLINE)))
        assertEquals("Sign-in was refused for this account. Ask your administrator.",signIn(AuthFailure(AuthFailure.Kind.REFUSED)))
        assertEquals("Too many attempts. Wait a minute and try again.",signIn(AuthFailure(AuthFailure.Kind.RATE_LIMITED)))
        AuthFailure.Kind.entries.forEach { assertEquals(it.message,signIn(AuthFailure(it))) }
    }
    @Test fun deviceErrorsMatchTheFieldAppCopy() {
        assertEquals("This phone is registered to a different account. Ask your administrator.",signIn(ConvexFunctionError("Device identity mismatch")))
        assertEquals("Your assignment changed. Ask your administrator to re-register this phone.",signIn(ConvexFunctionError("Device scope changed")))
        assertEquals("Your assignment changed. Ask your administrator to re-register this phone.",signIn(ConvexFunctionError("Device scope unavailable")))
        assertEquals("This phone isn't available for your account. Ask your administrator.",signIn(ConvexFunctionError("Device unavailable")))
        assertEquals("Couldn't verify this phone. Try again.",signIn(ConvexFunctionError("some new server code")))
        assertEquals("Couldn't verify this phone. Try again.",signIn(ConvexFunctionError(null)))
    }
    @Test fun unknownErrorsNeverEchoTheirTextAndNeverSaySaveChange() {
        val secret = IOException("https://example.convex.site/api/auth?password=hunter2")
        val text = signIn(secret)
        assertEquals(AuthMessages.SIGN_IN_FALLBACK,text)
        assertFalse(text.contains("save this change"))
        assertEquals(AuthMessages.CHECK_FALLBACK,AuthMessages.forFailure(IllegalStateException("boom"),AuthMessages.CHECK_FALLBACK))
    }
}
