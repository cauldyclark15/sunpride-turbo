package com.sunpride.van.sync

import com.sunpride.van.auth.*
import com.sunpride.van.AppEnvironment
import com.sunpride.van.device.*
import com.sunpride.van.storage.OutboxRow
import kotlinx.coroutines.runBlocking
import org.json.*
import org.junit.Assert.*
import org.junit.Test
import okhttp3.mockwebserver.*
import okio.Buffer
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream

class VanSyncClientTest {
    private val signer=JcaDeviceSigner(CryptoVectors.privateKey,CryptoVectors.publicKey,KeyProtection.SOFTWARE)
    private fun fixture()=javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().readText()
    private val identity get()=NativeIdentity("subject",JSONObject(fixture()).getJSONObject("seller").getString("profileId"),"unit","fingerprint","epoch")
    private fun snapshot(extra: (JSONObject)->Unit = {}): String {
        val data=JSONObject(fixture()); val at=data.getLong("serverTime"); data.remove("type"); data.remove("contractVersion"); data.remove("serverTime"); extra(data)
        return JSONObject().put("version",2).put("serverTime",at).put("hasMore",false).put("nextPageCursor",JSONObject.NULL).put("nextCursor","cursor")
            .put("bundles",JSONArray().put(JSONObject().put("scopeId","unit").put("scopeFingerprint","fingerprint").put("projection","van.bundle")
                .put("mode","snapshot").put("complete",true).put("changes",JSONArray()).put("authorization",JSONObject().put("epoch","epoch").put("expiresAt",at+60_000))
                .put("offlineLease",JSONObject().put("expiresAt",at+60_000)).put("data",data))).toString()
    }
    private class Transport(val responses: ArrayDeque<Pair<Int,String>>): VanTransport {
        val bodies=mutableListOf<ByteArray>(); val headers=mutableListOf<Map<String,String>>(); val paths=mutableListOf<String>(); val refreshes=mutableListOf<Boolean>()
        var challenges=0; var uploaded: ByteArray?=null
        var uploadReply=200 to "{\"version\":2,\"blobId\":\"blob\",\"status\":\"stored\"}"
        override fun token(refresh: Boolean): String { refreshes+=refresh; return "fake-access" }
        override fun challenge(deviceId: String): Pair<String,Long> { challenges++; return "10000000-0000-4000-8000-${challenges.toString().padStart(12,'0')}" to 1791338460000L }
        override fun post(path: String,body: ByteArray,headers: Map<String,String>,bearer: String): Pair<Int,String> { paths+=path; bodies+=body.copyOf(); this.headers+=headers; return responses.removeFirst() }
        override fun upload(url: String,jpeg: ByteArray,capability: String): Pair<Int,String> { uploaded=jpeg; return uploadReply }
    }
    private fun client(t: Transport)=VanSyncClient(t,signer,"d",identity)
    @Test fun f616BootstrapExplicitlyNegotiatesCatalogueWhileKeepingV2Envelope()=runBlocking {
        val t=Transport(ArrayDeque(listOf(200 to snapshot())))
        client(t).bootstrap()
        val request=JSONObject(String(t.bodies.single()))
        assertEquals(2,request.getInt("version"))
        val scope=request.getJSONArray("scopes").getJSONObject(0)
        assertEquals("van.bundle",scope.getString("projection"))
        assertTrue(scope.getJSONObject("params").getBoolean("catalogue"))
        Unit
    }
    /** IP-HH2: the phone asks for the van day and the product categories, and the answer lands inside the cached policy / product rows. */
    @Test fun ipHh2AsksForTheVanDayAndCategoriesAndKeepsThemInsideThePolicyAndProducts()=runBlocking {
        val t=Transport(ArrayDeque(listOf(200 to snapshot { d ->
            d.put("vanDay",JSONObject("""{"version":1,"device":{"deviceId":"d","vehicle":{"vehicleId":"v","vehicleCode":"V-1","plateNumber":"ABC-1234"}},"crew":{"onDevice":null,"members":[]},"roster":null,"tripId":null,"load":null}"""))
            VanBootstrapCodec.objects(d.getJSONArray("products")).forEach { it.put("category","Juices") }
        })))
        val local=JSONObject(client(t).bootstrap())
        val params=JSONObject(String(t.bodies.single())).getJSONArray("scopes").getJSONObject(0).getJSONObject("params")
        assertTrue(params.getBoolean("vanDay")); assertTrue(params.getBoolean("categories")); assertTrue(params.getBoolean("handheld"))
        assertFalse("the frozen top level is untouched",local.has("vanDay"))
        assertEquals("ABC-1234",VanBootstrapCodec.decode(local.toString()).policy.vanDay!!.vehicleLabel)
        assertTrue(VanBootstrapCodec.decode(local.toString()).products.all { it.category=="Juices" })
        Unit
    }
    @Test fun first401RefreshesOnceWithFreshProofAndExplicitServerTimestamp()=runBlocking {
        val t=Transport(ArrayDeque(listOf(401 to "",200 to snapshot())))
        client(t).bootstrap(); assertEquals(listOf(false,true),t.refreshes); assertEquals(2,t.challenges)
        assertArrayEquals(t.bodies[0],t.bodies[1]); assertNotEquals(t.headers[0]["x-device-nonce"],t.headers[1]["x-device-nonce"])
        t.headers.forEachIndexed { i,h ->
            assertEquals("1791338400000",h["x-device-timestamp"])
            assertTrue(CryptoVectors.verifyP1363(CryptoVectors.publicKey,RequestSigner.canonical("POST","/api/sync/pull",t.bodies[i],h.getValue("x-device-nonce"),h.getValue("x-device-timestamp").toLong()).toByteArray(),h.getValue("x-device-signature")))
        }; Unit
    }
    @Test fun evidenceUsesClaimThenRawBytesAndValidatesDigest()=runBlocking {
        val jpeg=byteArrayOf(1,2,3); val digest=hex(sha256(jpeg))
        val claim=JSONObject().put("version",2).put("uploadId","blob").put("uploadUrl","https://example.test/api/media/uploads/blob").put("uploadToken","fake-upload").toString()
        val t=Transport(ArrayDeque(listOf(200 to snapshot(),401 to "",200 to claim)))
        t.uploadReply=200 to JSONObject().put("version",2).put("blobId","blob").put("status","stored").put("sha256",digest).toString()
        val c=client(t); c.bootstrap(); c.evidence(digest,jpeg)
        assertArrayEquals(jpeg,t.uploaded); assertEquals(listOf("/api/sync/pull","/api/media/claims","/api/media/claims"),t.paths)
        assertArrayEquals(t.bodies[1],t.bodies[2]); assertEquals("truck-damage",JSONObject(String(t.bodies.last())).getString("purpose")); Unit
    }
    @Test fun mismatchedEvidenceCannotMarkAnotherPhotoStored()=runBlocking {
        val jpeg=byteArrayOf(1); val t=Transport(ArrayDeque(listOf(200 to snapshot(),200 to "{\"version\":2,\"uploadId\":\"blob\",\"uploadUrl\":\"https://example.test/api/media/uploads/blob\",\"uploadToken\":\"fake\"}")))
        val c=client(t); c.bootstrap(); assertTrue(runCatching { c.evidence(hex(sha256(jpeg)),jpeg) }.isFailure); Unit
    }
    @Test fun maximumPhotoBytesRemainRawNotBase64()=runBlocking {
        val jpeg=ByteArray(90_000); val digest=hex(sha256(jpeg))
        val t=Transport(ArrayDeque(listOf(200 to snapshot(),200 to "{\"version\":2,\"uploadId\":\"blob\",\"uploadUrl\":\"https://example.test/api/media/uploads/blob\",\"uploadToken\":\"fake\"}")))
        t.uploadReply=200 to JSONObject().put("version",2).put("blobId","blob").put("status","stored").put("sha256",digest).toString()
        val c=client(t); c.bootstrap(); c.evidence(digest,jpeg); assertEquals(90_000,t.uploaded!!.size); assertTrue(t.bodies.last().size<1024); Unit
    }
    @Test fun second401StopsWithoutSuccess()=runBlocking {
        val t=Transport(ArrayDeque(listOf(401 to "",401 to ""))); val e=runCatching { client(t).bootstrap() }.exceptionOrNull()
        assertEquals("unauthorized",(e as VanSyncFailure).code); assertEquals(2,t.challenges); Unit
    }
    @Test fun wholeRequestErrorsMapToHoldUpdateOrRetryWithoutRawText() {
        for((status,code) in listOf(401 to "unauthorized",403 to "unauthorized",409 to "unauthorized",426 to "version_unsupported",429 to "temporarily_unavailable",503 to "temporarily_unavailable")) {
            val e=VanSyncClient.error(status,"{\"version\":2,\"error\":{\"code\":\"scope_changed\",\"message\":\"raw-secret\"}}")
            // HTTP retry/update statuses take precedence over unrelated malformed server codes.
            if(status in listOf(401,403,409)) assertEquals(code,e.code)
            assertFalse(e.message!!.contains("raw-secret"))
        }
    }
    @Test fun okhttpStillHandlesGzipWithoutCookiesOrOrigin()=runBlocking {
        val server=MockWebServer(); server.start()
        try {
            val env=AppEnvironment("http://localhost:${server.port}"); val auth=AuthClient(env,InMemorySessionVault())
            val t=LiveVanTransport(env,auth,NativeApi(env,auth))
            val gz=ByteArrayOutputStream().apply { GZIPOutputStream(this).use { it.write(snapshot().toByteArray()) } }.toByteArray()
            server.enqueue(MockResponse().setHeader("Content-Encoding","gzip").setHeader("Set-Cookie","ignored=fake").setBody(Buffer().write(gz)))
            assertEquals(2,JSONObject(t.post("/api/sync/pull",byteArrayOf(123,125),emptyMap(),"fake-access").second).getInt("version"))
            val r=server.takeRequest(); assertNull(r.getHeader("Cookie")); assertNull(r.getHeader("Origin")); assertEquals("gzip",r.getHeader("Accept-Encoding"))
        } finally { server.shutdown() }; Unit
    }
    @Test fun uploadCapabilityCannotLeaveApiOrigin() {
        val env=AppEnvironment("https://sunpride.cauldnclark.com"); val auth=AuthClient(env,InMemorySessionVault())
        val t=LiveVanTransport(env,auth,NativeApi(env,auth))
        assertThrows(IllegalArgumentException::class.java) { t.upload("https://evil.test/api/media/uploads/x",byteArrayOf(1),"fake") }
    }
    @Test fun locationBecomesIndependentStableUuidOps()=runBlocking {
        val p=JSONObject().put("clientPingId","ping").put("recordedAt",1000).put("tripId","trip")
        val r=JSONObject().put("version",2).put("results",JSONArray().put(JSONObject().put("clientOpId","ping").put("opType","location.record").put("status","duplicate").put("retryable",false)
            .put("ack",JSONObject().put("entityId","ping").put("movementId",JSONObject.NULL).put("serverTime",1001))))
        val t=Transport(ArrayDeque(listOf(200 to r.toString())))
        assertEquals("accepted",client(t).location(listOf(p.toString())).single().status)
        val op=JSONObject(String(t.bodies.single())).getJSONArray("operations").getJSONObject(0)
        assertEquals("location.record",op.getString("opType")); assertEquals("ping",op.getString("clientOpId")); assertEquals(p.toString(),op.getJSONObject("payload").toString()); Unit
    }
    @Test fun financialPayloadAndUuidRemainFrozenAcrossTransportConversion() {
        for(kind in V2VanCodec.BUSINESS_OPS) {
            val op=JSONObject().put("kind",kind).put("clientRequestId","op-id").put("payload",JSONObject().put("deviceTime",1000).put("amountMinor","9007199254740991"))
            val row=OutboxRow(identity.partitionSubject,"d","op-id","trip",kind,op.toString(),1001)
            val v2=V2VanCodec.operation(row)
            assertEquals("op-id",v2.getString("clientOpId")); assertEquals(1000,v2.getLong("clientTime").toInt()); assertEquals(op.getJSONObject("payload").toString(),v2.getJSONObject("payload").toString())
        }
    }
    @Test fun duplicateRetainsOriginalAckAndUnknownStatusesFreeze() {
        val op=JSONObject().put("clientOpId","id").put("opType","sale.record")
        val r=JSONObject().put("clientOpId","id").put("opType","sale.record").put("status","duplicate").put("retryable",false)
            .put("ack",JSONObject().put("entityId","sale").put("movementId","move").put("serverTime",123))
        val body=JSONObject().put("version",2).put("results",JSONArray().put(r))
        assertEquals(123L,V2VanCodec.results(body,listOf(op)).single().ack!!.serverTime)
        r.put("status","future_status"); assertEquals("rejected",V2VanCodec.results(body,listOf(op)).single().status)
    }
    @Test fun wrongScopeEpochSellerPartialAndExpiredSnapshotCannotPromote() {
        val original=JSONObject(snapshot())
        fun bad(change:(JSONObject,JSONObject)->Unit) { val o=JSONObject(original.toString()); change(o,o.getJSONArray("bundles").getJSONObject(0)); assertTrue(runCatching { V2VanCodec.snapshot(o,identity,0) }.isFailure) }
        bad { _,b -> b.put("scopeFingerprint","other") }; bad { _,b -> b.getJSONObject("authorization").put("epoch","other") }
        bad { _,b -> b.getJSONObject("data").getJSONObject("seller").put("profileId","other") }; bad { o,_ -> o.put("hasMore",true) }
        bad { o,b -> b.getJSONObject("offlineLease").put("expiresAt",o.getLong("serverTime")) }
    }
}
