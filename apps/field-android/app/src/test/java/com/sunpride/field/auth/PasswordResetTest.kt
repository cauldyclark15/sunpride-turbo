package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** SP-0186: forgot password link, sign-in flag, forced change routing. Fake HTTP and fake credentials only. */
class PasswordResetTest {
    private val server = MockWebServer().apply { start() }
    private val vault = InMemorySessionVault()
    private val env = AppEnvironment(server.url("/").toString().trimEnd('/'))
    private val auth = AuthClient(env, vault)
    private val flags = mutableListOf<Boolean>()

    @Before fun sink() { PasswordChange.requiredSink = { flags += it } }
    @After fun close() { PasswordChange.requiredSink = null; server.shutdown() }

    private fun tokens(extra: JSONObject.() -> Unit = {}): String {
        val now = System.currentTimeMillis()
        return JSONObject().put("version", 2).put("serverTime", now).put("sessionToken", "sps_session")
            .put("sessionExpiresAt", now + 604800000).put("accessToken", "spa_access")
            .put("accessExpiresAt", now + 900000).apply(extra).toString()
    }
    private fun take() = server.takeRequest(1, TimeUnit.SECONDS)!!
    private fun error(code: Int, name: String) = MockResponse().setResponseCode(code)
        .setBody(JSONObject().put("error", JSONObject().put("code", name).put("message", "x")).toString())

    @Test fun signInSaysPasswordChangeIsSupportedAndReadsTheFlag() {
        server.enqueue(MockResponse().setBody(tokens { put("mustChangePassword", true) }))
        assertTrue(auth.signIn("seller@example.test", "K7PQ-M4XR-2W"))
        val body = JSONObject(take().body.readUtf8())
        assertEquals("supported", body.getString("passwordChange"))
        assertEquals("sps_session", vault.readSession())
        assertEquals(listOf(true), flags)
    }

    @Test fun normalSignInHasNoFlag() {
        server.enqueue(MockResponse().setBody(tokens()))
        assertFalse(auth.signIn("seller@example.test", "fake-password"))
        assertEquals(listOf(false), flags)
    }

    @Test fun expiredTemporaryPasswordShowsThePlainMessage() {
        server.enqueue(error(401, "temporary_password_expired"))
        val e = runCatching { auth.signIn("seller@example.test", "K7PQ-M4XR-2W") }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.TEMPORARY_PASSWORD_EXPIRED, e.kind)
        assertEquals("This temporary password has expired. Ask your admin for a new one.", e.text)
        assertNull(vault.readSession())
    }

    @Test fun wrongPasswordStaysTheUsualMessage() {
        server.enqueue(error(401, "invalid_credentials"))
        val e = runCatching { auth.signIn("seller@example.test", "nope-nope") }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.INVALID_CREDENTIALS, e.kind)
    }

    @Test fun oldBuildRefusalIsPlainWords() {
        server.enqueue(error(403, "password_change_required"))
        val e = runCatching { auth.signIn("seller@example.test", "x-password") }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED, e.kind)
        assertFalse(e.text.contains("password_change_required"))
    }

    @Test fun anyCallRefusedForANewPasswordRoutesThereAndKeepsTheSession() {
        server.enqueue(MockResponse().setBody(tokens()))
        auth.signIn("seller@example.test", "K7PQ-M4XR-2W"); take(); flags.clear()
        server.enqueue(error(403, "password_change_required"))
        val api = NativeApi(env, auth)
        val e = runCatching { api.post("/api/sync/pull", JSONObject().put("version", 2)) }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED, e.kind)
        assertEquals(listOf(true), flags)
        assertEquals("sps_session", vault.readSession()) // nothing wiped: the session and the phone's work stay
    }

    @Test fun refreshRefusedForANewPasswordDoesNotEndTheSession() {
        vault.saveSession("sps_session")
        server.enqueue(error(403, "password_change_required"))
        val e = runCatching { auth.accessToken() }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED, e.kind)
        assertEquals("sps_session", vault.readSession())
    }

    @Test fun meCarriesTheFlagBothWays() {
        server.enqueue(MockResponse().setBody(tokens()))
        auth.signIn("seller@example.test", "fake-password"); take(); flags.clear()
        val api = NativeApi(env, auth)
        server.enqueue(MockResponse().setBody(JSONObject().put("version", 2).put("mustChangePassword", true).toString()))
        val e = runCatching { api.me() }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED, e.kind)
        server.enqueue(MockResponse().setBody(JSONObject().put("version", 2).put("mustChangePassword", false).toString()))
        api.me()
        assertEquals(listOf(true, false), flags)
    }

    @Test fun successfulChangeClearsTheFlag() {
        server.enqueue(MockResponse().setBody(tokens { put("mustChangePassword", true) }))
        auth.signIn("seller@example.test", "K7PQ-M4XR-2W"); take()
        server.enqueue(MockResponse().setBody("""{"ok":true}"""))
        auth.changePassword("K7PQ-M4XR-2W", "my-own-password", "my-own-password")
        assertEquals(PasswordChange.PATH, take().path)
        assertEquals(listOf(true, false), flags)
    }

    @Test fun forgotPasswordOpensTheWebsitePageOnTheSameServer() {
        assertEquals("https://sunpride.cauldnclark.com/forgot-password",
            PasswordChange.forgotPasswordUrl("https://sunpride.cauldnclark.com"))
        assertEquals("https://sunpride.cauldnclark.com/forgot-password",
            PasswordChange.forgotPasswordUrl("https://sunpride.cauldnclark.com/"))
        assertEquals("http://10.0.2.2:5060/forgot-password", PasswordChange.forgotPasswordUrl("http://10.0.2.2:5060"))
        assertNull(PasswordChange.forgotPasswordUrl(""))
        assertNull(PasswordChange.forgotPasswordUrl("javascript:alert(1)"))
    }
}
