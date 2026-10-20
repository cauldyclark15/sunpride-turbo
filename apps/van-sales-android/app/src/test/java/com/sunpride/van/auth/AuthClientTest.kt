package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import okhttp3.mockwebserver.*
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import java.util.concurrent.TimeUnit

/** All tokens and credentials here are invented test values. */
class AuthClientTest {
    private lateinit var server: MockWebServer
    private val vault = InMemorySessionVault()
    private var now = 1_780_000_000_000L
    private lateinit var auth: AuthClient
    @Before fun setUp() {
        server = MockWebServer().apply { start() }
        auth = AuthClient(AppEnvironment("http://localhost:${server.port}"),vault,clock={now},deviceKey={JSONObject().put("keyId","test-key").put("publicKeySpki","test-spki")})
    }
    @After fun tearDown() { server.shutdown() }
    private fun take() = server.takeRequest(1,TimeUnit.SECONDS)!!
    private fun response(session: Boolean = true, token: String = "fake-access") = JSONObject().put("version",2).put("serverTime",now)
        .put("accessToken",token).put("accessExpiresAt",now+900_000).apply {
            if (session) put("sessionToken","fake-session").put("sessionExpiresAt",now+7*86_400_000L)
        }.toString()
    @Test fun signInPostsV2AppAndDeviceKeyAndStoresOnlySession() {
        server.enqueue(MockResponse().setBody(response()))
        auth.signIn("  seller@example.test ","fake-password")
        val r=take(); val b=JSONObject(r.body.readUtf8())
        assertEquals("POST",r.method); assertEquals("/api/auth/sign-in",r.path)
        assertEquals(2,b.getInt("version")); assertEquals("van-android",b.getString("app")); assertEquals("test-key",b.getJSONObject("deviceKey").getString("keyId"))
        assertEquals("seller@example.test",b.getString("email")); assertEquals("fake-password",b.getString("password"))
        assertNull(r.getHeader("Origin")); assertEquals("fake-session",vault.readSession()); assertEquals("fake-access",auth.accessToken())
    }
    @Test fun cookiesAreNeverReplayed() {
        server.enqueue(MockResponse().setHeader("Set-Cookie","sp_session=ignored").setBody(response()))
        auth.signIn("a@example.test","p"); take()
        server.enqueue(MockResponse().setBody(response(false)))
        auth.accessToken(true); assertNull(take().getHeader("Cookie"))
    }
    @Test fun headersCannotOverrideTheOpaqueSessionBody() {
        server.enqueue(MockResponse().setHeader("set-auth-token","ignored").setBody(response()))
        auth.signIn("a@example.test","p"); assertEquals("fake-session",vault.readSession())
    }
    @Test fun missingMalformedAndWhitespaceSessionsAreRejected() {
        for (bad in listOf(JSONObject.NULL,123,""," space","tab\there","x".repeat(4097))) {
            val b=JSONObject(response()).put("sessionToken",bad)
            server.enqueue(MockResponse().setBody(b.toString()))
            expect(AuthFailure.Kind.SERVER) { auth.signIn("a@example.test","p") }; assertNull(vault.readSession())
        }
    }
    @Test fun oldBodyTokenAndMalformedJsonAreNotAccepted() {
        for (body in listOf("{\"token\":\"legacy\"}","not json","{}")) {
            server.enqueue(MockResponse().setBody(body)); expect(AuthFailure.Kind.SERVER) { auth.signIn("a@example.test","p") }
        }
    }
    @Test fun wrongPasswordStoresNothing() {
        server.enqueue(MockResponse().setResponseCode(401)); expect(AuthFailure.Kind.INVALID_CREDENTIALS) { auth.signIn("a@example.test","wrong") }; assertNull(vault.readSession())
    }
    @Test fun refusalsRateLimitsAndServerErrorsStayFixed() {
        for ((status,kind) in listOf(403 to AuthFailure.Kind.REFUSED,429 to AuthFailure.Kind.RATE_LIMITED,500 to AuthFailure.Kind.SERVER)) {
            server.enqueue(MockResponse().setResponseCode(status).setBody("raw secret")); expect(kind) { auth.signIn("a@example.test","p") }
        }
    }
    @Test fun offlineIsReportedWithoutRequestDetails() {
        server.shutdown(); expect(AuthFailure.Kind.OFFLINE) { auth.signIn("a@example.test","p") }
    }
    @Test fun unconfiguredEnvironmentDoesNotSend() {
        expect(AuthFailure.Kind.NOT_CONFIGURED) { AuthClient(AppEnvironment(""),vault).signIn("a@example.test","p") }; assertEquals(0,server.requestCount)
    }
    @Test fun refreshUsesSessionBearerAndExplicitLifetimeNotJwtClaims() {
        vault.saveSession("fake-session"); server.enqueue(MockResponse().setBody(response(false)))
        assertEquals("fake-access",auth.accessToken()); val r=take()
        assertEquals("POST",r.method); assertEquals("/api/auth/refresh",r.path); assertEquals("Bearer fake-session",r.getHeader("Authorization"))
        assertEquals("test-key",JSONObject(r.body.readUtf8()).getString("deviceKeyId"))
        now+=13*60_000; assertEquals("fake-access",auth.accessToken()); assertEquals(1,server.requestCount)
        now+=60_001; server.enqueue(MockResponse().setBody(response(false,"refreshed")))
        assertEquals("refreshed",auth.accessToken()); assertEquals("fake-session",vault.readSession())
    }
    @Test fun rejectedRefreshWipesSessionAndDevice() {
        vault.saveSession("fake-session"); vault.deviceId="d"
        server.enqueue(MockResponse().setResponseCode(401)); expect(AuthFailure.Kind.SESSION_EXPIRED) { auth.accessToken() }
        assertNull(vault.readSession()); assertNull(vault.deviceId)
    }
    @Test fun transientRefreshFailureRetainsSession() {
        vault.saveSession("fake-session"); server.enqueue(MockResponse().setResponseCode(502))
        expect(AuthFailure.Kind.SERVER) { auth.accessToken() }; assertEquals("fake-session",vault.readSession())
    }
    @Test fun signOutWipesLocallyEvenOffline() {
        vault.saveSession("fake-session"); vault.deviceId="d"; server.shutdown()
        assertFalse(auth.signOut()); assertNull(vault.readSession()); assertNull(vault.deviceId)
    }
    @Test fun signOutPostsVersionAndStableSessionBearer() {
        vault.saveSession("fake-session"); server.enqueue(MockResponse().setBody("{\"version\":2,\"revoked\":true}"))
        assertTrue(auth.signOut()); val r=take(); assertEquals("/api/auth/sign-out",r.path)
        assertEquals("Bearer fake-session",r.getHeader("Authorization")); assertEquals(2,JSONObject(r.body.readUtf8()).getInt("version"))
    }
    @Test fun badAccessAndExpiredLifetimeDoNotReplaceSession() {
        for (b in listOf(JSONObject(response()).put("accessToken","bad token"),JSONObject(response()).put("accessExpiresAt",now))) {
            server.enqueue(MockResponse().setBody(b.toString())); expect(AuthFailure.Kind.SERVER) { auth.signIn("a@example.test","p") }; assertNull(vault.readSession())
        }
    }
    companion object {
        fun expect(kind: AuthFailure.Kind, block: () -> Unit) {
            try { block(); fail("expected $kind") } catch(e: AuthFailure) { assertEquals(kind,e.kind) }
        }
    }
}
