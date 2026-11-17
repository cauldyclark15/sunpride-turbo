package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import com.sunpride.van.sync.LiveVanTransport
import com.sunpride.van.sync.VanSyncClient
import com.sunpride.van.ui.UserMessages
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/** SP-0187: forgot password link and the forced Set a new password flow, against fake HTTP responses. */
class PasswordResetTest {
    private lateinit var server: MockWebServer
    private lateinit var env: AppEnvironment
    private val vault = InMemorySessionVault()
    private var now = 1_780_000_000_000L
    private lateinit var auth: AuthClient
    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        env = AppEnvironment("http://localhost:${server.port}")
        auth = AuthClient(env,vault,clock = { now })
    }
    @After fun tearDown() { server.shutdown() }
    private fun take() = server.takeRequest(1,TimeUnit.SECONDS)!!
    private fun signInBody(mustChange: Boolean? = null) = JSONObject().put("version",2).put("serverTime",now)
        .put("accessToken","fake-access").put("accessExpiresAt",now+900_000)
        .put("sessionToken","fake-session").put("sessionExpiresAt",now+7*86_400_000L)
        .apply { if (mustChange != null) put("mustChangePassword",mustChange) }.toString()
    private val required = """{"error":{"code":"password_change_required","message":"private-secret"}}"""

    @Test fun signInBodySaysPasswordChangeSupported() {
        server.enqueue(MockResponse().setBody(signInBody()))
        auth.signIn("seller@example.test","fake-password")
        assertEquals("supported",JSONObject(take().body.readUtf8()).getString("passwordChange"))
        assertFalse(auth.passwordChangeRequired.value); assertFalse(auth.hasTemporaryPassword)
    }
    @Test fun mustChangePasswordRaisesTheScreenAndTheTemporaryPasswordIsReusedFromMemory() {
        server.enqueue(MockResponse().setBody(signInBody(true)))
        auth.signIn("seller@example.test","K7PQ-M4XR-2W"); take()
        assertTrue(auth.passwordChangeRequired.value); assertTrue(auth.hasTemporaryPassword)
        assertEquals("fake-session",vault.readSession())
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        auth.setNewPassword(null,"my-new-password","my-new-password")
        val r = take(); assertEquals("/api/auth/change-password",r.path)
        val b = JSONObject(r.body.readUtf8())
        assertEquals("K7PQ-M4XR-2W",b.getString("currentPassword")); assertEquals("my-new-password",b.getString("newPassword"))
        assertFalse(auth.passwordChangeRequired.value); assertFalse(auth.hasTemporaryPassword)
        assertEquals("fake-session",vault.readSession())
    }
    @Test fun afterRestartTheTypedTemporaryPasswordIsUsed() {
        vault.saveSession("fake-session")
        val restarted = AuthClient(env,vault,clock = { now })
        restarted.markPasswordChangeRequired()
        server.enqueue(MockResponse().setBody(JSONObject().put("version",2).put("accessToken","fake-access")
            .put("serverTime",now).put("accessExpiresAt",now+900_000).toString()))
        server.enqueue(MockResponse().setBody("{\"ok\":true}"))
        restarted.setNewPassword("TYPED-TEMP","my-new-password","my-new-password")
        take(); assertEquals("TYPED-TEMP",JSONObject(take().body.readUtf8()).getString("currentPassword"))
        assertFalse(restarted.passwordChangeRequired.value)
    }
    @Test fun expiredTemporaryPasswordShowsThePlainMessage() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"temporary_password_expired","message":"private-secret"}}"""))
        val e = try { auth.signIn("a@example.test","OLD-TEMP"); null } catch (f: AuthFailure) { f }!!
        assertEquals(AuthFailure.Kind.TEMPORARY_PASSWORD_EXPIRED,e.kind)
        assertEquals("This temporary password has expired. Ask your admin for a new one.",e.text)
        assertNull(vault.readSession())
    }
    @Test fun plainWrongPasswordIsUnchanged() {
        server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"invalid_credentials"}}"""))
        AuthClientTest.expect(AuthFailure.Kind.INVALID_CREDENTIALS) { auth.signIn("a@example.test","wrong") }
    }
    @Test fun signInRefusedForPasswordChangeReadsPlainly() {
        server.enqueue(MockResponse().setResponseCode(403).setBody(required))
        val e = try { auth.signIn("a@example.test","p"); null } catch (f: AuthFailure) { f }!!
        assertEquals("Set a new password at sunpride.cauldnclark.com first, then sign in here.",e.text)
    }
    @Test fun restartMeFlagBringsTheScreenBackBeforeRegisteringAndKeepsTheSession() {
        vault.saveSession("fake-session")
        val restarted = AuthClient(env,vault,clock = { now })
        val devices = RestDeviceApi(NativeApi(env,restarted))
        server.enqueue(MockResponse().setBody(JSONObject().put("version",2).put("accessToken","fake-access")
            .put("serverTime",now).put("accessExpiresAt",now+900_000).toString()))
        server.enqueue(MockResponse().setBody("""{"version":2,"mustChangePassword":true}"""))
        AuthClientTest.expect(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED) { devices.mine("AQID") }
        assertTrue(restarted.passwordChangeRequired.value)
        assertEquals("fake-session",vault.readSession()); assertEquals(2,server.requestCount) // no challenge/bind
    }
    @Test fun forbiddenPasswordChangeRequiredFromAnyApiCallRoutesToTheScreen() {
        vault.saveSession("fake-session")
        val api = NativeApi(env,auth)
        server.enqueue(MockResponse().setBody(JSONObject().put("version",2).put("accessToken","fake-access")
            .put("serverTime",now).put("accessExpiresAt",now+900_000).toString()))
        server.enqueue(MockResponse().setResponseCode(403).setBody(required))
        AuthClientTest.expect(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED) { api.request("/api/v1/credit/check",JSONObject()) }
        assertTrue(auth.passwordChangeRequired.value); assertEquals("fake-session",vault.readSession())
    }
    @Test fun refreshRefusedForPasswordChangeKeepsTheSession() {
        vault.saveSession("fake-session")
        server.enqueue(MockResponse().setResponseCode(403).setBody(required))
        AuthClientTest.expect(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED) { auth.accessToken() }
        assertEquals("fake-session",vault.readSession()); assertTrue(auth.passwordChangeRequired.value)
    }
    @Test fun syncRefusalRoutesToTheScreenWithoutHoldingOrDroppingWork() {
        val t = LiveVanTransport(env,auth,NativeApi(env,auth))
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"version":2,"error":{"code":"password_change_required"}}"""))
        val (code,text) = t.post("/api/sync/push",byteArrayOf(123,125),emptyMap(),"fake-access")
        assertTrue(auth.passwordChangeRequired.value)
        val e = VanSyncClient.error(code,text)
        // Not "unauthorized" (which holds the store for review), and retryable so queued work is sent after the change.
        assertEquals("password_change_required",e.code); assertTrue(e.retryable)
        assertEquals("password_change_required",VanSyncClient.error(403,required).code)
        assertEquals(AuthFailure.Kind.PASSWORD_CHANGE_REQUIRED.message,UserMessages.forFailure(e))
        assertFalse(UserMessages.forFailure(e).contains("private-secret"))
    }
    @Test fun otherForbiddenRefusalsAreUnchanged() {
        assertEquals("unauthorized",VanSyncClient.error(403,"""{"version":2,"error":{"code":"forbidden"}}""").code)
        assertFalse(auth.notePasswordChangeRefusal(403,"""{"error":{"code":"forbidden"}}"""))
        assertFalse(auth.notePasswordChangeRefusal(401,required)); assertFalse(auth.passwordChangeRequired.value)
    }
    @Test fun signOutClearsTheFlagAndTheTemporaryPassword() {
        server.enqueue(MockResponse().setBody(signInBody(true)))
        auth.signIn("a@example.test","TEMP"); take()
        server.enqueue(MockResponse().setBody("{}"))
        auth.signOut()
        assertFalse(auth.passwordChangeRequired.value); assertFalse(auth.hasTemporaryPassword)
    }
    @Test fun forgotPasswordOpensTheWebsitePage() {
        assertEquals("https://sunpride.cauldnclark.com/forgot-password",AuthClient.forgotPasswordUrl("https://sunpride.cauldnclark.com"))
        assertEquals("https://sunpride.cauldnclark.com/forgot-password",AuthClient.forgotPasswordUrl("https://sunpride.cauldnclark.com/"))
        assertEquals("http://10.0.2.2:5071/forgot-password",AuthClient.forgotPasswordUrl("http://10.0.2.2:5071"))
    }
}
