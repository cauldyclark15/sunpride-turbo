package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.util.Base64
import java.util.concurrent.TimeUnit

/** Fake credentials and tokens only; nothing here is a real account or secret. */
class AuthClientTest {
    private lateinit var server: MockWebServer
    private lateinit var env: AppEnvironment
    private val vault = InMemorySessionVault()
    private var now = 1_780_000_000_000L
    private lateinit var auth: AuthClient

    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        val origin = "http://localhost:${server.port}"
        env = AppEnvironment(origin)
        auth = AuthClient(env, vault, clock = { now })
    }
    @After fun tearDown() { server.shutdown() }

    private fun tokens(session: String = "sps_session", access: String = "spa_access") = JSONObject()
        .put("version", 2).put("serverTime", now).put("sessionToken", session)
        .put("sessionExpiresAt", now + 604800000).put("accessToken", access)
        .put("accessExpiresAt", now + 900000).toString()
    private fun take() = server.takeRequest(1, TimeUnit.SECONDS)!!

    @Test fun signInPostsJsonWithoutOriginAndStoresSetAuthToken() {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("set-auth-token", "sps_fake-session-1")
            .setBody(tokens()))
        auth.signIn("  seller@example.test ", "fake-password")
        val request = take()
        assertEquals("POST", request.method)
        assertEquals(AuthClient.SIGN_IN, request.path)
        assertNull("no Origin header", request.getHeader("Origin"))
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals("seller@example.test", body.getString("email"))
        assertEquals("fake-password", body.getString("password"))
        assertEquals("sps_session", vault.readSession())
        assertTrue(auth.isSignedIn)
    }

    @Test fun signInStoresBodyTokenWithoutHeaderAndDoesNotReplayCookies() {
        val session = "sps_fake-body-session-XYZ"
        server.enqueue(MockResponse().setResponseCode(200)
            .setHeader("Set-Cookie", "better-auth.session_token=cookie-secret; Path=/; HttpOnly")
            .setBody(tokens(session)))
        auth.signIn("seller@example.test", "fake-password-XYZ")
        val signIn = take()
        assertNull(signIn.getHeader("Origin"))
        assertEquals(session, vault.readSession())
        assertTrue(auth.isSignedIn)
        assertFalse(auth.toString().contains(session))
        assertFalse(vault.toString().contains(session))

        server.enqueue(MockResponse().setBody(tokens(session)))
        auth.accessToken(true)
        val exchange = take()
        assertEquals("Bearer $session", exchange.getHeader("Authorization"))
        assertNull(exchange.getHeader("Cookie"))
    }

    @Test fun headerWinsOverBodyToken() {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("set-auth-token", "fake-header-session")
            .setBody(tokens()))
        auth.signIn("seller@example.test", "fake-password")
        assertEquals("sps_session", vault.readSession())
    }

    @Test fun missingAndMalformedBodyTokensFailWithoutStoringSessionOrEchoingToken() {
        val badBodies = listOf(
            "{}", """{"user":{"token":"nested-only"}}""", """{"token":null}""",
            """{"token":123}""", """{"token":""}""", """{"token":" space"}""",
            """{"token":"tab\there"}""", """{"token":"line\nhere"}""",
            JSONObject().put("token", "x".repeat(AuthClient.MAX_SESSION_TOKEN_LENGTH + 1)).toString(),
            "invalid json"
        )
        badBodies.forEach { body ->
            server.enqueue(MockResponse().setResponseCode(200).setBody(body))
            val failure = runCatching { auth.signIn("seller@example.test", "fake-password") }.exceptionOrNull()
            assertTrue("expected fixed auth failure", failure is AuthFailure)
            assertEquals(AuthFailure.Kind.SERVER, (failure as AuthFailure).kind)
            assertFalse(failure.toString().contains(body))
            assertNull(vault.readSession())
        }
    }

    @Test fun malformedHeaderIsNotReplacedByBodyToken() {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("set-auth-token", "bad token")
            .setBody(tokens("invalid session")))
        expect(AuthFailure.Kind.SERVER) { auth.signIn("seller@example.test", "fake-password") }
        assertNull(vault.readSession())
    }

    @Test fun wrongPasswordIsCredentialsErrorAndStoresNothing() {
        server.enqueue(MockResponse().setResponseCode(401).setHeader("set-auth-token", "must-not-be-used")
            .setBody("""{"code":"INVALID_EMAIL_OR_PASSWORD"}"""))
        expect(AuthFailure.Kind.INVALID_CREDENTIALS) { auth.signIn("a@example.test", "wrong") }
        assertNull(vault.readSession())
    }

    @Test fun throttleNamesTheRealWaitFromTheServer() {
        // FLD-004: sign-in allows 10 tries per 5 minutes; the message must not understate the wait.
        server.enqueue(MockResponse().setResponseCode(429)
            .setBody("""{"version":2,"serverTime":1,"error":{"code":"rate_limited","retryable":true,"retryAfterMs":241000,"action":"retry"}}"""))
        val waited = runCatching { auth.signIn("a@example.test", "p") }.exceptionOrNull() as AuthFailure
        assertEquals(AuthFailure.Kind.RATE_LIMITED, waited.kind)
        assertEquals("Too many attempts. Try again in 5 minutes.", waited.text)
        assertEquals("Too many attempts. Try again in 1 minute.", AuthFailure.text(AuthFailure.Kind.RATE_LIMITED, 20_000))
        server.enqueue(MockResponse().setResponseCode(429))
        val unknown = runCatching { auth.signIn("a@example.test", "p") }.exceptionOrNull() as AuthFailure
        assertEquals("Too many attempts. Wait up to 5 minutes and try again.", unknown.text)
        assertFalse(unknown.text.contains("a minute"))
    }

    @Test fun forbiddenRateLimitServerAndMissingHeaderMapToFixedErrors() {
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"code":"MISSING_OR_NULL_ORIGIN"}"""))
        expect(AuthFailure.Kind.REFUSED) { auth.signIn("a@example.test", "p") }
        server.enqueue(MockResponse().setResponseCode(429))
        expect(AuthFailure.Kind.RATE_LIMITED) { auth.signIn("a@example.test", "p") }
        server.enqueue(MockResponse().setResponseCode(500).setBody("stack trace with secrets"))
        expect(AuthFailure.Kind.SERVER) { auth.signIn("a@example.test", "p") }
        server.enqueue(MockResponse().setResponseCode(200).setBody("{}"))
        expect(AuthFailure.Kind.SERVER) { auth.signIn("a@example.test", "p") }
        assertNull(vault.readSession())
    }

    @Test fun offlineIsReportedAsOffline() {
        server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
        expect(AuthFailure.Kind.OFFLINE) { auth.signIn("a@example.test", "p") }
        server.shutdown()
        expect(AuthFailure.Kind.OFFLINE) { auth.signIn("a@example.test", "p") }
    }

    @Test fun unconfiguredEnvironmentMakesNoRequest() {
        val client = AuthClient(AppEnvironment(""), vault)
        expect(AuthFailure.Kind.NOT_CONFIGURED) { client.signIn("a@example.test", "p") }
        assertEquals(0, server.requestCount)
    }

    @Test fun accessTokenRefreshUsesSessionBearerAndIsCachedUntilNearExpiry() {
        vault.saveSession("sps_fake-session")
        val jwt1 = "spa_first"
        server.enqueue(MockResponse().setBody(tokens(access = jwt1)))
        assertEquals(jwt1, auth.accessToken())
        val request = take()
        assertEquals("POST", request.method)
        assertEquals(AuthClient.REFRESH_PATH, request.path)
        assertEquals("Bearer sps_fake-session", request.getHeader("Authorization"))
        now += 13 * 60_000 // still > 60 s before exp: cached
        assertEquals(jwt1, auth.accessToken())
        assertEquals(1, server.requestCount)
        now += 60_000 + 1 // inside the refresh margin: exchange again
        val jwt2 = "spa_second"
        server.enqueue(MockResponse().setBody(tokens(access = jwt2)))
        assertEquals(jwt2, auth.accessToken())
        assertEquals(2, server.requestCount)
    }

    @Test fun rejectedSessionWipesVaultAndRequiresSignIn() {
        vault.saveSession("sps_fake-session"); vault.deviceId = "dev1"
        server.enqueue(MockResponse().setResponseCode(401))
        expect(AuthFailure.Kind.SESSION_EXPIRED) { auth.accessToken() }
        assertNull(vault.readSession())
        assertNull(vault.deviceId)
    }

    @Test fun tokenExchangeServerErrorKeepsSession() {
        vault.saveSession("sps_fake-session")
        server.enqueue(MockResponse().setResponseCode(502))
        expect(AuthFailure.Kind.SERVER) { auth.accessToken() }
        server.enqueue(MockResponse().setBody("""{"token":"not-a-jwt"}"""))
        expect(AuthFailure.Kind.SERVER) { auth.accessToken() }
        assertEquals("sps_fake-session", vault.readSession())
    }

    @Test fun signOutPostsSessionBearerAndWipesEvenWhenOffline() {
        vault.saveSession("sps_fake-session"); vault.deviceId = "dev1"
        server.enqueue(MockResponse().setBody("""{"version":2,"revoked":true}"""))
        assertTrue(auth.signOut())
        val request = take()
        assertEquals(AuthClient.SIGN_OUT, request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer sps_fake-session", request.getHeader("Authorization"))
        assertNull(vault.readSession()); assertNull(vault.deviceId)

        vault.saveSession("sps_fake-session-2")
        server.shutdown()
        assertFalse(auth.signOut())
        assertNull(vault.readSession())
    }

    @Test fun jwtExpiryParsing() {
        assertEquals(1_700_000_000_000L, AuthClient.expiryMillis(jwt(1_700_000_000)))
        assertNull(AuthClient.expiryMillis("garbage"))
    }

    companion object {
        fun jwt(expSeconds: Long): String {
            val enc = Base64.getUrlEncoder().withoutPadding()
            val header = enc.encodeToString("""{"alg":"RS256"}""".toByteArray())
            val payload = enc.encodeToString("""{"aud":"sunpride","exp":$expSeconds}""".toByteArray())
            return "$header.$payload.fake-signature"
        }

        fun expect(kind: AuthFailure.Kind, block: () -> Unit) {
            try { block(); fail("expected $kind") } catch (e: AuthFailure) { assertEquals(kind, e.kind) }
        }
    }
}
