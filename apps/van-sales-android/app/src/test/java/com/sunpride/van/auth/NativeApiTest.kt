package com.sunpride.van.auth

import com.sunpride.van.AppEnvironment
import okhttp3.mockwebserver.*
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*

/** v2 replaces function envelopes; preserve retry, refusal, caching and redaction regressions. */
class NativeApiTest {
    private lateinit var server: MockWebServer
    private lateinit var api: NativeApi
    private var refreshes=0
    private val replies=ArrayDeque<MockResponse>()
    private val requests=mutableListOf<RecordedRequest>()
    @Before fun setup() {
        server=MockWebServer()
        server.dispatcher=object: Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = if (request.path==AuthClient.REFRESH) {
                refreshes++
                MockResponse().setBody(JSONObject().put("version",2).put("serverTime",1000).put("accessToken","fake-access-$refreshes").put("accessExpiresAt",901000).toString())
            } else { requests+=request; replies.removeFirst() }
        }
        server.start()
        val env=AppEnvironment("http://localhost:${server.port}")
        api=NativeApi(env,AuthClient(env,InMemorySessionVault().apply { saveSession("fake-session") }))
    }
    @After fun close() { server.shutdown() }
    @Test fun meUsesGetWithAppAndKeyHeadersAndAccessBearer() {
        replies+=MockResponse().setBody("{\"version\":2,\"device\":null}")
        assertTrue(api.request("/api/me",headers=mapOf("X-App" to "van-android","X-Device-Key-Id" to "test-key")).isNull("device"))
        val r=requests.single(); assertEquals("GET",r.method); assertEquals("van-android",r.getHeader("X-App")); assertEquals("test-key",r.getHeader("X-Device-Key-Id")); assertEquals("Bearer fake-access-1",r.getHeader("Authorization"))
    }
    @Test fun commandsUseExactRestPathAndBody() {
        replies+=MockResponse().setBody("{\"version\":2,\"nonce\":\"n\"}")
        api.request("/api/devices/challenge",JSONObject().put("version",2).put("deviceId","d"))
        val r=requests.single(); assertEquals("POST",r.method); assertEquals("/api/devices/challenge",r.path); assertEquals("d",JSONObject(r.body.readUtf8()).getString("deviceId"))
    }
    @Test fun first401RefreshesExactlyOnce() {
        replies+=MockResponse().setResponseCode(401); replies+=MockResponse().setBody("{\"version\":2}")
        api.request("/api/me"); assertEquals(2,refreshes); assertEquals(2,requests.size); assertNotEquals(requests[0].getHeader("Authorization"),requests[1].getHeader("Authorization"))
    }
    @Test fun second401Stops() {
        repeat(2) { replies+=MockResponse().setResponseCode(401) }
        AuthClientTest.expect(AuthFailure.Kind.SESSION_EXPIRED) { api.request("/api/me") }; assertEquals(2,requests.size)
    }
    @Test fun accessIsReusedAcrossReads() {
        repeat(3) { replies+=MockResponse().setBody("{\"version\":2}"); api.request("/api/me") }; assertEquals(1,refreshes)
    }
    @Test fun refusalCodeNeverLeaksServerMessage() {
        replies+=MockResponse().setResponseCode(409).setBody("{\"version\":2,\"error\":{\"code\":\"already_bound\",\"message\":\"raw-secret\"}}")
        val e=assertThrows(NativeApiFailure::class.java) { api.request("/api/devices/bind",JSONObject()) }
        assertEquals("already_bound",e.code); assertFalse(e.toString().contains("raw-secret"))
    }
    @Test fun malformedAndWrongVersionFailClosed() {
        for(body in listOf("<html>","{\"version\":1}")) {
            replies+=MockResponse().setBody(body); AuthClientTest.expect(AuthFailure.Kind.SERVER) { api.request("/api/me") }
        }
    }
    @Test fun locationConsentIsAnExplicitAuthenticatedRestChoiceBeforeRecording() {
        replies+=MockResponse().setBody("{\"id\":\"consent\",\"enabled\":true,\"effectiveFrom\":1000}")
        api.locationConsent(true)
        val r=requests.single(); assertEquals("/api/v1/location/consent",r.path); assertEquals("POST",r.method)
        assertEquals("Bearer fake-access-1",r.getHeader("Authorization")); assertTrue(JSONObject(r.body.readUtf8()).getBoolean("enabled"))
    }
    @Test fun locationWithdrawalSendsFalseAndAnUnconfirmedChoiceFailsClosed() {
        replies+=MockResponse().setBody("{\"enabled\":false,\"effectiveFrom\":1001}")
        api.locationConsent(false); assertFalse(JSONObject(requests.single().body.readUtf8()).getBoolean("enabled"))
        replies+=MockResponse().setBody("{\"enabled\":false,\"effectiveFrom\":1002}")
        AuthClientTest.expect(AuthFailure.Kind.SERVER) { api.locationConsent(true) }
    }
    @Test fun unsupportedEndpointsAreNeverCalled() {
        assertThrows(IllegalArgumentException::class.java) { api.request("/api/query",JSONObject()) }; assertEquals(0,server.requestCount)
    }
}
