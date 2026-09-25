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

class ConvexFunctionsTest {
    private lateinit var server: MockWebServer
    private val vault = InMemorySessionVault()
    private val now = 1_780_000_000_000L
    private var tokensIssued = 0
    private val functionResponses = ArrayDeque<MockResponse>()
    private val functionRequests = mutableListOf<Pair<String, String>>() // path to bearer
    private lateinit var functions: ConvexFunctions

    @Before fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                AuthClient.CONVEX_TOKEN -> {
                    tokensIssued++
                    MockResponse().setBody("""{"token":"${jwt(now / 1000 + 900).removeSuffix("fake-signature")}sig$tokensIssued"}""")
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
        val env = AppEnvironment(origin, origin)
        vault.saveSession("fake-session")
        functions = ConvexFunctions(env, AuthClient(env, vault, clock = { now }))
    }
    @After fun tearDown() { server.shutdown() }
    private var lastBody = ""

    @Test fun encodesPathArgsFormatAndDecodesValue() {
        functionResponses += MockResponse().setBody("""{"status":"success","value":{"deviceId":"d1","status":"active","bound":false,"allowedApp":"ANDROID"},"logLines":[]}""")
        val value = functions.query("mobile/devices:mine", JSONObject().put("publicKey", "SPKI").put("app", "ANDROID")) as JSONObject
        assertEquals("d1", value.getString("deviceId"))
        val (path, bearer) = functionRequests.single()
        assertEquals("/api/query", path)
        assertTrue(bearer.startsWith("Bearer ") && bearer != "Bearer fake-session")
        val body = JSONObject(lastBody)
        assertEquals("mobile/devices:mine", body.getString("path"))
        assertEquals("json", body.getString("format"))
        assertEquals("SPKI", body.getJSONObject("args").getString("publicKey"))
    }

    @Test fun mutationsUseMutationEndpointAndNullValueDecodesToNull() {
        functionResponses += MockResponse().setBody("""{"status":"success","value":null}""")
        assertNull(functions.mutation("mobile/devices:challenge", JSONObject().put("deviceId", "d1")))
        assertEquals("/api/mutation", functionRequests.single().first)
    }

    @Test fun http401RefreshesJwtOnceAndRetries() {
        functionResponses += MockResponse().setResponseCode(401)
        functionResponses += MockResponse().setBody("""{"status":"success","value":42}""")
        assertEquals(42, functions.query("x:y", JSONObject()))
        assertEquals(2, tokensIssued)
        assertEquals(2, functionRequests.size)
        assertTrue(functionRequests[0].second != functionRequests[1].second)
    }

    @Test fun second401IsSessionExpiredNoThirdAttempt() {
        functionResponses += MockResponse().setResponseCode(401)
        functionResponses += MockResponse().setResponseCode(401)
        expect(AuthFailure.Kind.SESSION_EXPIRED) { functions.query("x:y", JSONObject()) }
        assertEquals(2, functionRequests.size)
    }

    @Test fun jwtIsReusedAcrossCalls() {
        repeat(3) { functionResponses += MockResponse().setBody("""{"status":"success","value":1}""") }
        repeat(3) { functions.query("x:y", JSONObject()) }
        assertEquals(1, tokensIssued)
    }

    @Test fun errorEnvelopeBecomesConvexFunctionErrorWithCode() {
        functionResponses += MockResponse().setResponseCode(400)
            .setBody("""{"status":"error","errorMessage":"[Request ID: x] Server Error Uncaught ConvexError: Device unavailable","errorData":"Device unavailable"}""")
        val e = assertThrows(ConvexFunctionError::class.java) { functions.mutation("mobile/devices:challenge", JSONObject()) }
        assertEquals("Device unavailable", e.code)
        functionResponses += MockResponse().setResponseCode(500).setBody("""{"status":"error","errorMessage":"Server Error"}""")
        assertNull(assertThrows(ConvexFunctionError::class.java) { functions.query("x:y", JSONObject()) }.code)
    }

    @Test fun nonJsonOrUnknownStatusIsServerError() {
        functionResponses += MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>")
        expect(AuthFailure.Kind.SERVER) { functions.query("x:y", JSONObject()) }
        functionResponses += MockResponse().setBody("""{"status":"weird"}""")
        expect(AuthFailure.Kind.SERVER) { functions.query("x:y", JSONObject()) }
    }

    @Test fun decodeAndEncodeArePure() {
        val encoded = JSONObject(ConvexFunctions.encode("p:q", JSONObject().put("a", 1)))
        assertEquals(setOf("path", "args", "format"), encoded.keys().asSequence().toSet())
        assertEquals("p:q", encoded.getString("path"))
        assertEquals(1, encoded.getJSONObject("args").getInt("a"))
        assertEquals("json", encoded.getString("format"))
        assertEquals("v", ConvexFunctions.decode(JSONObject("""{"status":"success","value":"v"}""")))
    }
}
