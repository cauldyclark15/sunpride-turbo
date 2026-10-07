package com.sunpride.van.sync

import com.sunpride.van.data.*
import com.sunpride.van.device.*
import com.sunpride.van.auth.*
import com.sunpride.van.AppEnvironment
import com.sunpride.van.storage.OutboxRow
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import okhttp3.mockwebserver.*
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

class VanSyncClientTest {
    private val signer = JcaDeviceSigner(CryptoVectors.privateKey,CryptoVectors.publicKey,KeyProtection.SOFTWARE)
    private fun fixture() = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().readText()
    private class Transport(val responses: ArrayDeque<Pair<Int,String>>) : VanTransport {
        val bodies = mutableListOf<ByteArray>(); val headers = mutableListOf<Map<String,String>>(); val refreshes = mutableListOf<Boolean>()
        var challenges = 0
        override fun token(refresh: Boolean): String { refreshes += refresh; return "test-jwt" }
        override fun challenge(deviceId: String): Pair<String,Long> { challenges++; return "10000000-0000-4000-8000-${challenges.toString().padStart(12,'0')}" to 1791338460000L }
        override fun post(path: String, body: ByteArray, headers: Map<String,String>, bearer: String): Pair<Int,String> { bodies += body.copyOf(); this.headers += headers; return responses.removeFirst() }
    }
    @Test fun first401RefreshesExactlyOnceWithFreshNonceAndSkewSafeTimestamp() = runBlocking {
        val t = Transport(ArrayDeque(listOf(401 to "",200 to fixture())))
        VanSyncClient(t,signer,"d").bootstrap()
        assertEquals(listOf(false,true),t.refreshes); assertEquals(2,t.challenges)
        assertArrayEquals(t.bodies[0],t.bodies[1]); assertNotEquals(t.headers[0]["x-mobile-nonce"],t.headers[1]["x-mobile-nonce"])
        t.headers.forEachIndexed { i,h ->
            assertEquals("1791338430000",h["x-mobile-timestamp"]); assertEquals("VAN_ANDROID",h["x-mobile-app"])
            assertEquals(RequestSigner.bodyDigest(t.bodies[i]),h["x-mobile-body-digest"])
            assertTrue(CryptoVectors.verifyP1363(CryptoVectors.publicKey,RequestSigner.canonical("POST","/van/v1/bootstrap",t.bodies[i],h.getValue("x-mobile-nonce"),h.getValue("x-mobile-timestamp").toLong()).toByteArray(),h.getValue("x-mobile-signature")))
        }
        Unit
    }
    @Test fun evidenceUsesFreshProofForExactRouteOnEveryAttempt() = runBlocking {
        val request = JSONObject(javaClass.classLoader!!.getResourceAsStream("evidence-request.json")!!.bufferedReader().readText())
        val response = javaClass.classLoader!!.getResourceAsStream("evidence-response.json")!!.bufferedReader().readText()
        val t = Transport(ArrayDeque(listOf(401 to "",200 to response)))
        VanSyncClient(t,signer,"d").evidence(request.getString("sha256"),java.util.Base64.getDecoder().decode(request.getString("dataBase64")))
        assertEquals(2,t.challenges); assertArrayEquals(t.bodies[0],t.bodies[1])
        assertNotEquals(t.headers[0]["x-mobile-nonce"],t.headers[1]["x-mobile-nonce"])
        t.headers.forEachIndexed { i,h ->
            assertTrue(CryptoVectors.verifyP1363(CryptoVectors.publicKey,RequestSigner.canonical("POST","/van/v1/evidence",t.bodies[i],h.getValue("x-mobile-nonce"),h.getValue("x-mobile-timestamp").toLong()).toByteArray(),h.getValue("x-mobile-signature")))
        }
        Unit
    }
    @Test fun mismatchedEvidenceResponseCannotMarkAnotherPhotoStored() = runBlocking {
        val request = JSONObject(javaClass.classLoader!!.getResourceAsStream("evidence-request.json")!!.bufferedReader().readText())
        val t = Transport(ArrayDeque(listOf(200 to JSONObject().put("type","van.evidence.response").put("contractVersion",1).put("serverTime",1).put("sha256","a".repeat(64)).put("status","stored").toString())))
        assertTrue(runCatching { VanSyncClient(t,signer,"d").evidence(request.getString("sha256"),java.util.Base64.getDecoder().decode(request.getString("dataBase64"))) }.exceptionOrNull() is VanWireFailure)
        Unit
    }
    @Test fun maximumPhotoBodyIsBelow128KiBAndBase64HasNoLineBreaks() {
        val jpeg = com.sunpride.van.evidence.BaselineJpegTest.padded(com.sunpride.van.evidence.BaselineJpegTest.fixture(),96_000)
        assertEquals(96_000,jpeg.size)
        val body = VanEvidenceCodec.request("d".repeat(64),hex(sha256(jpeg)),jpeg)
        assertTrue(body.size < 128*1024); assertFalse(JSONObject(String(body)).getString("dataBase64").contains('\n'))
    }
    @Test fun second401StopsAndNeverLabelsDataAccepted() = runBlocking {
        val t = Transport(ArrayDeque(listOf(401 to "",401 to "")))
        val e = runCatching { VanSyncClient(t,signer,"d").bootstrap() }.exceptionOrNull()
        assertTrue(e is VanSyncFailure); assertEquals("unauthorized",(e as VanSyncFailure).code); assertEquals(2,t.challenges); Unit
    }
    @Test fun wholeRequestCodesAndRetryabilityAreMappedWithoutRawMessage() {
        listOf(400 to "version_unsupported",401 to "unauthorized",413 to "invalid_request",429 to "temporarily_unavailable",500 to "temporarily_unavailable").forEach { (status,code) ->
            val e = VanSyncClient.error(status,JSONObject().put("type","error.response").put("contractVersion",1).put("code",code).put("message","raw-secret").put("retryable",status>=500 || status==429).toString())
            assertEquals(code,e.code); assertEquals(status>=500 || status==429,e.retryable); assertFalse(e.message!!.contains("raw-secret"))
        }
    }
    @Test fun okhttpDecodesGzipWithoutCookiesOrOrigin() = runBlocking {
        val server = MockWebServer(); server.start()
        try {
            val env = AppEnvironment("http://localhost:${server.port}","http://localhost:${server.port}")
            val vault = InMemorySessionVault().apply { saveSession("fake-session") }
            val auth = AuthClient(env,vault)
            val transport = LiveVanTransport(env,auth,ConvexFunctions(env,auth))
            val compressed = ByteArrayOutputStream().apply { GZIPOutputStream(this).use { it.write(fixture().toByteArray()) } }.toByteArray()
            server.enqueue(MockResponse().setHeader("Content-Encoding","gzip").setHeader("Set-Cookie","ignored=fake").setBody(Buffer().write(compressed)))
            val response = transport.post("/van/v1/bootstrap",byteArrayOf(123,125),emptyMap(),"fake-jwt")
            assertEquals(2,VanBootstrapCodec.decode(response.second).products.size)
            val request = server.takeRequest(); assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Origin")); assertEquals("gzip",request.getHeader("Accept-Encoding"))
        } finally { server.shutdown() }; Unit
    }
}
