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
        env = AppEnvironment(origin, origin)
        auth = AuthClient(env, vault, clock = { now })
    }
    @After fun tearDown() { server.shutdown() }

    private fun take() = server.takeRequest(1, TimeUnit.SECONDS)!!

    @Test fun signInPostsJsonWithoutOriginAndStoresSetAuthToken() {
        server.enqueue(MockResponse().setResponseCode(200).setHeader("set-auth-token", "fake-session-1")
            .setBody("""{"token":"body-token-is-ignored","user":{}}"""))
        auth.signIn("  seller@example.test ", "fake-password")
        val request = take()
        assertEquals("POST", request.method)
        assertEquals(AuthClient.SIGN_IN, request.path)
        assertNull("no Origin header", request.getHeader("Origin"))
        assertTrue(request.getHeader("Content-Type")!!.startsWith("application/json"))
        val body = JSONObject(request.body.readUtf8())
        assertEquals("seller@example.test", body.getString("email"))
        assertEquals("fake-password", body.getString("password"))
        assertEquals("fake-session-1", vault.readSession())
        assertTrue(auth.isSignedIn)
    }

    @Test fun wrongPasswordIsCredentialsErrorAndStoresNothing() {
        server.enqueue(MockResponse().setResponseCode(401).setHeader("set-auth-token", "must-not-be-used")
            .setBody("""{"code":"INVALID_EMAIL_OR_PASSWORD"}"""))
        expect(AuthFailure.Kind.INVALID_CREDENTIALS) { auth.signIn("a@example.test", "wrong") }
        assertNull(vault.readSession())
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
        val client = AuthClient(AppEnvironment("", ""), vault)
        expect(AuthFailure.Kind.NOT_CONFIGURED) { client.signIn("a@example.test", "p") }
        assertEquals(0, server.requestCount)
    }

    @Test fun convexTokenExchangeUsesSessionBearerAndIsCachedUntilNearExpiry() {
        vault.saveSession("fake-session")
        val jwt1 = jwt(expSeconds = now / 1000 + 900)
        server.enqueue(MockResponse().setBody("""{"token":"$jwt1"}"""))
        assertEquals(jwt1, auth.convexToken())
        val request = take()
        assertEquals("GET", request.method)
        assertEquals(AuthClient.CONVEX_TOKEN, request.path)
        assertEquals("Bearer fake-session", request.getHeader("Authorization"))
        now += 13 * 60_000 // still > 60 s before exp: cached
        assertEquals(jwt1, auth.convexToken())
        assertEquals(1, server.requestCount)
        now += 60_000 + 1 // inside the refresh margin: exchange again
        val jwt2 = jwt(expSeconds = now / 1000 + 900)
        server.enqueue(MockResponse().setBody("""{"token":"$jwt2"}"""))
        assertEquals(jwt2, auth.convexToken())
        assertEquals(2, server.requestCount)
    }

    @Test fun rejectedSessionWipesVaultAndRequiresSignIn() {
        vault.saveSession("fake-session"); vault.deviceId = "dev1"
        server.enqueue(MockResponse().setResponseCode(401))
        expect(AuthFailure.Kind.SESSION_EXPIRED) { auth.convexToken() }
        assertNull(vault.readSession())
        assertNull(vault.deviceId)
    }

    @Test fun tokenExchangeServerErrorKeepsSession() {
        vault.saveSession("fake-session")
        server.enqueue(MockResponse().setResponseCode(502))
        expect(AuthFailure.Kind.SERVER) { auth.convexToken() }
        server.enqueue(MockResponse().setBody("""{"token":"not-a-jwt"}"""))
        expect(AuthFailure.Kind.SERVER) { auth.convexToken() }
        assertEquals("fake-session", vault.readSession())
    }

    @Test fun signOutPostsSessionBearerAndWipesEvenWhenOffline() {
        vault.saveSession("fake-session"); vault.deviceId = "dev1"
        server.enqueue(MockResponse().setBody("{}"))
        assertTrue(auth.signOut())
        val request = take()
        assertEquals(AuthClient.SIGN_OUT, request.path)
        assertEquals("POST", request.method)
        assertEquals("Bearer fake-session", request.getHeader("Authorization"))
        assertNull(vault.readSession()); assertNull(vault.deviceId)

        vault.saveSession("fake-session-2")
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
            val payload = enc.encodeToString("""{"aud":"convex","exp":$expSeconds}""".toByteArray())
            return "$header.$payload.fake-signature"
        }

        fun expect(kind: AuthFailure.Kind, block: () -> Unit) {
            try { block(); fail("expected $kind") } catch (e: AuthFailure) { assertEquals(kind, e.kind) }
        }
    }
}
