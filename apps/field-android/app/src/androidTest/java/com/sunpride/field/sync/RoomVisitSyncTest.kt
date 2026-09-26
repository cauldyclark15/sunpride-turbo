package com.sunpride.field.sync

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.EncryptedFieldDatabase
import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.RoomFieldStore
import com.sunpride.field.storage.StoreDatabase
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.storage.ScopedSnapshot
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Exercises the production SQLCipher/Room state transitions, not an in-memory fake store. */
@RunWith(AndroidJUnit4::class)
class RoomVisitSyncTest {
    private val scope = StoreScope("issuer|${UUID.randomUUID()}", "device-test", "scope-test")
    private lateinit var db: StoreDatabase
    private lateinit var store: RoomFieldStore
    private val signer = object : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf(1)
        override fun sign(message: String) = "test-signature"
    }

    @Before fun open() {
        db = EncryptedFieldDatabase.open(InstrumentationRegistry.getInstrumentation().targetContext)
        store = RoomFieldStore(db, scope)
    }
    @After fun close() { db.close() }

    private suspend fun queuedVisit(): List<IntentRow> {
        val generation = store.stage(ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList()))
        store.swap(generation, "cursor-start", Long.MAX_VALUE, Long.MAX_VALUE)
        val check = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null,
            "planned-1", "outlet-1", emptyList(), null, null, null, null, null, at = 100)
        val note = VisitIntentFactory.create(scope, "visit.activity", check.clientVisitId, check.requestId,
            check.requestId, "planned-1", "outlet-1", emptyList(), null, "Field note", null, null, null, at = 100)
        val checkout = VisitIntentFactory.create(scope, "visit.checkOut", check.clientVisitId, check.requestId,
            note.requestId, "planned-1", "outlet-1", emptyList(), null, null, "completed", null, null, at = 100)
        listOf(check, note, checkout).forEach { store.enqueue(it, 100) }
        return listOf(check, note, checkout)
    }

    private class Gateway : VisitTransport {
        val pushes = mutableListOf<ByteArray>()
        val operations = mutableListOf<JSONObject>()
        val accepted = mutableMapOf<String, JSONObject>()
        override fun challenge(deviceId: String) = UUID.randomUUID().toString() to 60_100L
        override fun token(refresh: Boolean) = "test-only"
        override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
            if (path.endsWith("/pull")) return 200 to JSONObject().put("type", "pull.response")
                .put("contractVersion", 1).put("serverTime", 150).put("nextCursor", "cursor-next")
                .put("hasMore", false).put("changes", JSONArray()).toString()
            pushes += bytes.copyOf()
            val sent = JSONObject(String(bytes, Charsets.UTF_8)).getJSONArray("operations")
            val results = JSONArray()
            for (index in 0 until sent.length()) {
                val op = sent.getJSONObject(index)
                operations += op
                val id = op.getString("clientRequestId")
                val ack = accepted.getOrPut(id) { JSONObject().put("entityId", if (op.getString("kind") == "visit.checkIn")
                    "server-visit" else "server-event-$id").put("eventIds", JSONArray().put("event-$id"))
                    .put("serverTime", 150) }
                results.put(JSONObject().put("kind", op.getString("kind")).put("clientRequestId", id)
                    .put("status", "accepted").put("ack", ack))
            }
            return 200 to JSONObject().put("type", "push.response").put("contractVersion", 1)
                .put("serverTime", 150).put("results", results).toString()
        }
    }

    private fun sync(transport: Gateway, target: FieldStore = store) = VisitSync(
        SignedVisitGateway(transport, signer, scope.deviceId, { 0L }), target, scope,
        bootstrap = { error("unexpected bootstrap") }, now = { 100 }, pause = {}, jitter = { 0 })

    @Test fun acceptedWhileSendingCompletesCheckinNoteAndCheckout() = runBlocking {
        val intents = queuedVisit()
        val gateway = Gateway()
        assertTrue(sync(gateway).sync())
        assertEquals(listOf("done", "done", "done"), store.history().map { it.second.state })
        assertEquals(3, gateway.pushes.size) // dependents wait for durable check-in/note acks
        assertEquals(intents.map { it.requestId }, gateway.operations.map { it.getString("clientRequestId") })
        for (op in gateway.operations.drop(1)) {
            assertEquals("server-visit", op.getJSONObject("payload").getString("visitId"))
        }
        assertEquals(intents[0].requestId, gateway.operations[1].getJSONArray("dependsOn").getString(0))
        assertEquals(intents[1].requestId, gateway.operations[2].getJSONArray("dependsOn").getString(0))
        assertEquals(0, store.status().queued + store.status().sending + store.status().review)
        assertEquals("All synced", store.status().label(150))
        assertTrue(store.pending().isEmpty())
        Unit
    }

    @Test fun interruptedAckRecordingReplaysSameServerAckAndFinishesOnce() = runBlocking {
        val intents = queuedVisit()
        val gateway = Gateway()
        var interrupt = true
        val interrupted = object : FieldStore by store {
            override suspend fun recordAck(requestId: String, entityId: String, eventIdsJson: String, serverTime: Long) {
                if (interrupt) { interrupt = false; error("interrupted before durable ack") }
                store.recordAck(requestId, entityId, eventIdsJson, serverTime)
            }
        }
        sync(gateway, interrupted).sync()
        assertEquals("retry_pending", store.syncHealth())
        assertNull(store.ack(intents[0].requestId))
        assertEquals("pending", store.history().first().second.state) // finally resets sending
        assertTrue(sync(gateway).sync())
        assertArrayEquals(gateway.pushes[0], gateway.pushes[1])
        assertEquals(3, gateway.accepted.size) // server dedupes the replay by request ID
        assertEquals(4, gateway.operations.size)
        assertTrue(store.history().all { it.second.state == "done" })
        assertEquals(0, store.status().queued + store.status().sending + store.status().review)
        // A repeated identical ack on a done row is idempotent, but a different one is forbidden.
        val ack = store.ack(intents[0].requestId)!!
        store.recordAck(ack.requestId, ack.entityId, ack.eventIdsJson, ack.serverTime)
        assertThrows(IllegalStateException::class.java) { runBlocking {
            store.recordAck(ack.requestId, "different-visit", ack.eventIdsJson, ack.serverTime)
        } }
        assertEquals(ack, store.ack(ack.requestId))
        Unit
    }
}
