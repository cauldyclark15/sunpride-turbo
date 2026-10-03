package com.sunpride.field.sync

import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import com.sunpride.field.AppEnvironment
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.ConvexFunctions
import com.sunpride.field.auth.InMemorySessionVault
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import java.util.Base64

class BootstrapTest {
    private fun fixture(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
    private val first get() = fixture("bootstrap-response.json")
    private val next get() = fixture("bootstrap-next-page.json")
    private fun page(text: String, number: Int, next: String?, cursor: String?) = JSONObject(text)
        .put("page", number).put("nextPageCursor", next ?: JSONObject.NULL).put("syncCursor", cursor ?: JSONObject.NULL).toString()
    @Test fun codecFixturesAndMalformed() {
        val p = BootstrapCodec.page(first)
        assertEquals("scope-v1", p.fingerprint)
        assertEquals("planned-1", p.visits.single().id)
        assertEquals("opaque-page-2", BootstrapCodec.page(next).next)
        for (text in listOf(first, next)) {
            assertEquals(JSONObject(text).toString(), JSONObject(String(BootstrapCodec.encode(BootstrapCodec.page(text)))).toString())
        }
        assertEquals("bootstrap.request", JSONObject(String(BootstrapCodec.request("device-1", "2026-09-26"))).getString("type"))
        listOf("error-invalid-cursor.json", "error-rebootstrap-required.json", "error-device-revoked.json", "error-version-unsupported.json")
            .forEach { name ->
                val text = fixture(name)
                val parsed = BootstrapCodec.error(text)
                assertTrue(parsed.code.isNotBlank())
                assertEquals(JSONObject(text).toString(), JSONObject(String(BootstrapCodec.encode(parsed))).toString())
            }
        assertEquals("version_unsupported", BootstrapCodec.error(
            """{"type":"error.response","contractVersion":1,"serverTime":1790380800000,"code":"version_unsupported","message":"version_unsupported","retryable":false}""").code)
        for (bad in listOf(first.dropLast(7), JSONObject(first).put("contractVersion", 2).toString(),
            JSONObject(first).put("employee", JSONObject.NULL).toString(),
            JSONObject(first).put("nextPageCursor", JSONObject.NULL).put("syncCursor", JSONObject.NULL).toString())) {
            assertThrows(WireFailure::class.java) { BootstrapCodec.page(bad) }
        }
        val unknown = JSONObject(fixture("unknown-response-enum.json"))
        assertFalse(BootstrapCodec.page(JSONObject(first)
            .put("employee", JSONObject(first).getJSONObject("employee").put("role", "future_role")).toString()).supported)
        assertEquals(ResponseStatus.Unknown("future_pending"),
            responseStatus(unknown.getJSONArray("results").getJSONObject(0).getString("status")))
    }
    @Test fun callSheetFixtureAndAbsentFieldDecode() {
        val sheet = BootstrapCodec.page(fixture("bootstrap-call-sheet-response.json")).callSheets.single()
        assertEquals("outlet-1", sheet.outletId)
        assertEquals(2L, sheet.revision)
        assertEquals("Puregold Example", sheet.header.accountName)
        assertNull(sheet.header.receivingInCharge)
        assertEquals(listOf("product-1", "product-2"), sheet.lines.map { it.productId })
        assertEquals("₱189.00", sheet.lines.first().pricing)
        assertNull(sheet.lines.last().barcode)
        assertTrue(BootstrapCodec.page(first).callSheets.isEmpty())
    }
    @Test fun callSheetMalformedRequiredFieldsAndWrongPageOutletFailClosed() {
        val original = fixture("bootstrap-call-sheet-response.json")
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("callSheets", JSONObject.NULL) },
            { it.getJSONArray("callSheets").getJSONObject(0).put("revision", 0) },
            { it.getJSONArray("callSheets").getJSONObject(0).put("revision", 1.5) },
            { it.getJSONArray("callSheets").getJSONObject(0).put("outletId", "not-in-page") },
            { it.getJSONArray("callSheets").getJSONObject(0).getJSONObject("header").remove("foc") },
            { it.getJSONArray("callSheets").getJSONObject(0).getJSONObject("header").put("accountName", "") },
            { it.getJSONArray("callSheets").getJSONObject(0).getJSONArray("lines").getJSONObject(0).remove("pricing") },
            { it.getJSONArray("callSheets").getJSONObject(0).put("lines", org.json.JSONArray().apply {
                repeat(101) { put(JSONObject().put("productId", "p$it").put("code", "").put("name", "")
                    .put("uom", "").put("barcode", JSONObject.NULL).put("pricing", JSONObject.NULL)) }
            }) }
        )
        mutations.forEach { mutate ->
            val o = JSONObject(original); mutate(o)
            assertThrows(WireFailure::class.java) { BootstrapCodec.page(o.toString()) }
        }
    }
    @Test fun nullableCallSheetTextAllowsEmptyStringButRequiresKeys() {
        val o = JSONObject(fixture("bootstrap-call-sheet-response.json"))
        o.getJSONArray("callSheets").getJSONObject(0).getJSONObject("header").put("address", "")
        assertEquals("", BootstrapCodec.page(o.toString()).callSheets.single().header.address)
    }
    @Test fun multipageCallSheetsMergeAndPromoteOnlyAtFinalCursor() {
        val one = page(fixture("bootstrap-call-sheet-response.json"), 1, "page-2", null)
        val two = JSONObject(fixture("bootstrap-call-sheet-response.json"))
        two.getJSONArray("plannedVisits").getJSONObject(0).put("id", "planned-2").put("outletId", "outlet-2")
        two.getJSONArray("outlets").getJSONObject(0).put("id", "outlet-2")
        two.getJSONArray("callSheets").getJSONObject(0).put("outletId", "outlet-2")
        val store = Store()
        val transport = Transport(mutableListOf(200 to one, 200 to page(two.toString(), 2, null, "final")))
        BootstrapClient(transport, Signer(), "device-1", { store }).fetch("2026-09-26", "issuer|person")
        assertEquals(listOf("outlet-1", "outlet-2"), store.snapshot!!.callSheets.map { it.outletId })
        assertEquals(2, store.snapshot!!.outlets.size)
        assertEquals(1, store.swaps)
        assertEquals("final", store.token)
    }
    @Test fun conflictingCallSheetAcrossPagesNeverPromotes() {
        val one = page(fixture("bootstrap-call-sheet-response.json"), 1, "page-2", null)
        val two = JSONObject(fixture("bootstrap-call-sheet-response.json"))
        two.getJSONArray("callSheets").getJSONObject(0).put("revision", 3)
        val store = Store()
        val transport = Transport(mutableListOf(200 to one, 200 to page(two.toString(), 2, null, "final")))
        assertThrows(BootstrapFailure::class.java) {
            BootstrapClient(transport, Signer(), "device-1", { store }).fetch("2026-09-26", "issuer|person")
        }
        assertNull(store.snapshot); assertEquals(0, store.swaps)
    }
    private class Store : FieldStore {
        var snapshot: ScopedSnapshot? = null; var token: String? = "old"; var held = false; var swaps = 0
        override suspend fun stage(snapshot: ScopedSnapshot): String { this.snapshot = snapshot; return "generation" }
        override suspend fun swap(generation: String, cursor: String, leaseExpiresAt: Long, cacheExpiresAt: Long, releaseHeld: Boolean) {
            token = cursor; if (releaseHeld) held = false; swaps++
        }
        override suspend fun todaysVisits(day: String) = snapshot?.visits ?: emptyList()
        override suspend fun outlets() = snapshot?.outlets ?: emptyList()
        override suspend fun isLeaseValid(now: Long) = !held
        override suspend fun enqueue(intent: IntentRow, now: Long) = Unit
        override suspend fun pending() = emptyList<Pair<IntentRow, OutboxRow>>()
        override suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long) = Unit
        override suspend fun recordRejection(requestId: String, code: String) = Unit
        override suspend fun ack(requestId: String): AckRow? = null
        override suspend fun cursor() = token
        override suspend fun setCursor(cursor: String?) { token = cursor }
        override suspend fun syncHealth() = "synced"
        override suspend fun setSyncHealth(value: String) = Unit
        override suspend fun holdForReview() { held = true; token = null }
    }
    private class Signer : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private class Transport(var responses: MutableList<Pair<Int,String>>) : BootstrapTransport {
        var challenges = 0; var refreshes = 0; val bodies = mutableListOf<ByteArray>()
        override fun challenge(deviceId: String): Pair<String,Long> {
            challenges++; return UUID.randomUUID().toString() to 1790380800000L
        }
        override fun token(refresh: Boolean): String { if (refresh) refreshes++; return "jwt" }
        override fun post(body: ByteArray, headers: Map<String,String>, bearer: String): Pair<Int,String> {
            bodies.add(body)
            assertEquals(com.sunpride.field.device.RequestSigner.bodyDigest(body), headers["x-mobile-body-digest"])
            assertEquals("1", headers["x-mobile-contract-version"])
            assertEquals("ANDROID", headers["x-mobile-app"])
            assertEquals("POST|/mobile/v1/bootstrap|${headers["x-mobile-body-digest"]}|${headers["x-mobile-nonce"]}|${headers["x-mobile-timestamp"]}", headers["x-mobile-signature"])
            return responses.removeAt(0)
        }
    }
    @Test fun multipageFailureDoesNotPromoteAndRetryUsesFreshProof() {
        val store = Store(); val t = Transport(mutableListOf(200 to next, 503 to ""))
        val client = BootstrapClient(t, Signer(), "device-1", { store })
        assertEquals(BootstrapFailure.Kind.RETRYABLE, assertThrows(BootstrapFailure::class.java) {
            client.fetch("2026-09-26", "issuer|person")
        }.kind)
        assertEquals("old", store.token); assertEquals(0, store.swaps)
        t.responses.addAll(listOf(200 to next, 200 to page(first, 2, null, "new")))
        client.fetch("2026-09-26", "issuer|person")
        assertEquals("new", store.token); assertEquals(1, store.swaps)
        assertEquals(4, t.challenges)
        assertEquals("opaque-page-2", JSONObject(String(t.bodies.last())).getString("pageCursor"))
    }
    @Test fun mockWebServerUsesExactSignedPostAndNoOrigin() {
        MockWebServer().use { server ->
            server.start()
            val url = server.url("/").toString().trimEnd('/')
            val env = AppEnvironment(url, url)
            val vault = InMemorySessionVault().apply { saveSession("test-session") }
            // Test-only syntactically valid JWT; no live bearer/credential is used.
            val payload = Base64.getUrlEncoder().withoutPadding().encodeToString("{\"exp\":9999999999}".toByteArray())
            server.enqueue(MockResponse().setBody("{\"token\":\"header.$payload.signature\"}"))
            server.enqueue(MockResponse().setBody(JSONObject().put("status", "success").put("value",
                JSONObject().put("nonce", UUID.randomUUID().toString()).put("expiresAt", 1790380860000L)).toString()))
            server.enqueue(MockResponse().setBody(first))
            val auth = AuthClient(env, vault)
            val transport = LiveBootstrapTransport(env, auth, ConvexFunctions(env, auth))
            BootstrapClient(transport, Signer(), "device-1", { Store() }, { 10_000L })
                .fetch("2026-09-26", "issuer|person")
            val token = server.takeRequest(); val challenge = server.takeRequest(); val post = server.takeRequest()
            assertEquals("/api/auth/convex/token", token.path)
            assertEquals("/api/mutation", challenge.path)
            assertEquals("/mobile/v1/bootstrap", post.path)
            assertNull(post.getHeader("Origin"))
            val bytes = post.body.readByteArray()
            assertEquals(com.sunpride.field.device.RequestSigner.bodyDigest(bytes), post.getHeader("x-mobile-body-digest"))
            assertEquals("device-1", JSONObject(String(bytes)).getString("deviceId"))
            assertEquals("Bearer header.$payload.signature", post.getHeader("Authorization"))
        }
    }
    @Test fun unauthorizedRefreshOnceAndRestart() {
        val store = Store()
        val t = Transport(mutableListOf(401 to "", 200 to first))
        BootstrapClient(t, Signer(), "device-1", { store }).fetch("2026-09-26", "issuer|person")
        assertEquals(1, t.refreshes); assertEquals(2, t.challenges)
        val r = Transport(mutableListOf(409 to fixture("error-rebootstrap-required.json"), 200 to first))
        BootstrapClient(r, Signer(), "device-1", { store }).fetch("2026-09-26", "issuer|person")
        assertEquals(2, r.challenges)
        val removed = Transport(mutableListOf(403 to fixture("error-device-revoked.json")))
        assertEquals(BootstrapFailure.Kind.REMOVED, assertThrows(BootstrapFailure::class.java) {
            BootstrapClient(removed, Signer(), "device-1", { store }).fetch("2026-09-26", "issuer|person")
        }.kind)
    }
}
