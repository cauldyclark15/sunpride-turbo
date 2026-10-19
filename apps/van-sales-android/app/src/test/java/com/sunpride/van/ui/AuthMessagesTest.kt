package com.sunpride.van.ui

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.auth.NativeApiFailure
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
        assertEquals("This phone is registered to a different account. Ask your administrator.",signIn(NativeApiFailure("already_bound",409)))
        assertEquals("Your assignment changed. Ask your administrator to re-register this phone.",signIn(NativeApiFailure("scope_withdrawn",403)))
        assertEquals("Your assignment changed. Ask your administrator to re-register this phone.",signIn(NativeApiFailure("scope_withdrawn",403)))
        assertEquals("This phone isn't available for your account. Ask your administrator.",signIn(NativeApiFailure("device_unavailable",403)))
        assertEquals("Couldn't verify this phone. Try again.",signIn(NativeApiFailure("some_new_code",400)))
        assertEquals("Couldn't verify this phone. Try again.",signIn(NativeApiFailure(null,500)))
    }
    @Test fun unknownErrorsNeverEchoTheirTextAndNeverSaySaveChange() {
        val secret = IOException("https://sunpride.example.test/api/auth?password=hunter2")
        val text = signIn(secret)
        assertEquals(AuthMessages.SIGN_IN_FALLBACK,text)
        assertFalse(text.contains("save this change"))
        assertEquals(AuthMessages.CHECK_FALLBACK,AuthMessages.forFailure(IllegalStateException("boom"),AuthMessages.CHECK_FALLBACK))
    }
}
