package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClientTest.Companion.expect
import com.sunpride.field.auth.AuthClientTest.Companion.jwt
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class ServerFunctionsTest {
    private lateinit var server: MockWebServer
    private val vault = InMemorySessionVault()
    private val now = 1_780_000_000_000L
    private var tokensIssued = 0
    private val functionResponses = ArrayDeque<MockResponse>()
    private val functionRequests = mutableListOf<Pair<String, String>>() // path to bearer
    private lateinit var functions: ServerFunctions

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                AuthClient.REFRESH_PATH -> {
                    tokensIssued++
                    MockResponse().setBody("""{"version":2,"serverTime":$now,"sessionExpiresAt":${now+9999999},"accessExpiresAt":${now+900000},"accessToken":"spa_sig$tokensIssued"}""")
                }
                else -> {
                    functionRequests += request.path!! to request.getHeader("Authorization")!!
                    lastBody = request.body.readUtf8()
                    functionResponses.removeFirst()
                }
            }
        }
        server.start()
        val origin = "http://localhost:${server.port}"
        val env = AppEnvironment(origin)
        vault.saveSession("sps_fake-session")
        functions = ServerFunctions(env, AuthClient(env, vault, clock = { now }))
    }
    @After fun tearDown() { server.shutdown() }
    private var lastBody = ""

    @Test fun encodesPathArgsFormatAndDecodesValue() {
        functionResponses += MockResponse().setBody("""{"version":2,"device":{"id":"d1","status":"active","bound":false,"allowedApp":"field-android"}}""")
        val value = functions.query("mobile/devices:mine", JSONObject()) as JSONObject
        assertEquals("d1", value.getString("deviceId"))
        assertEquals("/api/me", functionRequests.single().first)
        assertTrue(functionRequests.single().second.startsWith("Bearer spa_"))
        assertEquals("", lastBody)
    }
    @Test fun mutationsUseDeviceEndpoint() {
        functionResponses += MockResponse().setBody("""{"version":2,"nonce":"nonce","expiresAt":123}""")
        val value = functions.mutation("mobile/devices:challenge", JSONObject().put("deviceId", "d1")) as JSONObject
        assertEquals("nonce", value.getString("nonce"))
        assertEquals("/api/devices/challenge", functionRequests.single().first)
        assertEquals(2, JSONObject(lastBody).getInt("version"))
    }
    @Test fun http401RefreshesAccessOnceAndRetries() {
        functionResponses += MockResponse().setResponseCode(401)
        functionResponses += MockResponse().setBody("""{"version":2,"device":null}""")
        assertNull(functions.query("mobile/devices:mine", JSONObject()))
        assertEquals(2, tokensIssued); assertEquals(2, functionRequests.size)
        assertTrue(functionRequests[0].second != functionRequests[1].second)
    }
    @Test fun second401IsSessionExpiredNoThirdAttempt() {
        repeat(2) { functionResponses += MockResponse().setResponseCode(401) }
        expect(AuthFailure.Kind.SESSION_EXPIRED) { functions.query("mobile/devices:mine", JSONObject()) }
        assertEquals(2, functionRequests.size)
    }
    @Test fun accessIsReusedAcrossCalls() {
        repeat(3) { functionResponses += MockResponse().setBody("""{"version":2,"device":null}""") }
        repeat(3) { functions.query("mobile/devices:mine", JSONObject()) }
        assertEquals(1, tokensIssued)
    }
    @Test fun errorEnvelopeBecomesFixedCode() {
        functionResponses += MockResponse().setResponseCode(403).setBody("""{"version":2,"error":{"code":"device_revoked"}}""")
        val e = assertThrows(ServerError::class.java) { functions.mutation("mobile/devices:challenge", JSONObject()) }
        assertEquals("device_revoked", e.code)
        functionResponses += MockResponse().setResponseCode(500).setBody("stack with credentials")
        expect(AuthFailure.Kind.SERVER) { functions.query("mobile/devices:mine", JSONObject()) }
    }
    @Test fun nonJsonOrUnknownVersionIsServerError() {
        functionResponses += MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>")
        expect(AuthFailure.Kind.SERVER) { functions.query("mobile/devices:mine", JSONObject()) }
        functionResponses += MockResponse().setBody("""{"version":99}""")
        expect(AuthFailure.Kind.SERVER) { functions.query("mobile/devices:mine", JSONObject()) }
    }
}
