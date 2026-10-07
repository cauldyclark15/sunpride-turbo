package com.sunpride.van.sync

import com.sunpride.van.data.*
import com.sunpride.van.evidence.DamageEvidence
import com.sunpride.van.storage.*
import kotlinx.coroutines.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class VanDamageSyncTest {
    private val sha = "a".repeat(64)
    private val events = mutableListOf<String>()
    private inner class Photos : DamageEvidence {
        var stored = false; var deleted = false
        override fun read(sha256: String, maxBytes: Int) = byteArrayOf(1,2)
        override fun uploaded(sha256: String) = stored
        override fun markUploaded(sha256: String) { stored = true; events += "marker" }
        override fun delete(sha256: String) { deleted = true; events += "delete" }
    }
    private inner class Store(val photos: Photos) : VanSyncStore {
        override val scope = StoreScope("issuer|seller",UUID.randomUUID().toString())
        val rows = mutableListOf<OutboxRow>(); var held = false; var health = "new"
        fun add(photo: Boolean = false): OutboxRow {
            val id = UUID.randomUUID().toString(); val kind = if (photo) "truck.damage" else "trip.start"
            val payload = JSONObject().put("tripId","trip")
            if (photo) payload.put("photoSha256",sha)
            return OutboxRow(scope.fullAuthSubject,scope.deviceId,id,"trip",kind,
                JSONObject().put("kind",kind).put("clientRequestId",id).put("payload",payload).toString(),rows.size.toLong()).also(rows::add)
        }
        override suspend fun pending(excluding: Set<String>) = if (held) emptyList() else rows.filter { it.status == "pending" && it.clientRequestId !in excluding }.take(20)
        override suspend fun canSync() = !held
        override suspend fun resetSending() { rows.indices.forEach { i -> if (rows[i].status == "sending") rows[i] = rows[i].copy(status="pending") } }
        override suspend fun markSending(ids: List<String>) { rows.indices.forEach { i -> if (rows[i].clientRequestId in ids) rows[i] = rows[i].copy(status="sending") } }
        override suspend fun hold() { held = true }
        override suspend fun setHealth(health: String, successTime: Long?) { this.health = health }
        override suspend fun replaceBootstrap(text: String) = VanBootstrapCodec.decode(text)
        override suspend fun recordResult(row: OutboxRow, result: PushResult) {
            events += "ack"
            val i = rows.indexOfFirst { it.clientRequestId == row.clientRequestId }
            rows[i] = rows[i].copy(status=if (result.status == "accepted") "done" else result.status)
        }
        override suspend fun cleanupAcknowledgedPhotos() {
            if (!photos.deleted && rows.any { damagePhotoSha(it) != null && it.status == "done" } && rows.none { damagePhotoSha(it) != null && it.status != "done" }) photos.delete(sha)
        }
    }
    private inner class Gateway(val store: Store) : VanGateway {
        var failUpload = false; var failPush = false; var holdDuringUpload = false; var cancelUpload = false
        val pushed = mutableListOf<List<String>>()
        override suspend fun bootstrap() = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!.bufferedReader().readText()
        override suspend fun evidence(sha256: String, jpeg: ByteArray) {
            events += "upload"
            if (cancelUpload) throw CancellationException()
            if (failUpload) throw VanSyncFailure("offline",true)
            if (holdDuringUpload) store.hold()
        }
        override suspend fun push(operations: List<OutboxRow>): List<PushResult> {
            events += "push"; pushed += operations.map { it.clientRequestId }
            if (failPush) throw VanSyncFailure("offline",true)
            return operations.map { PushResult(it.kind,it.clientRequestId,"accepted",PushAck("damage-record",null,1)) }
        }
    }
    @Test fun uploadsBeforePushAndDeletesOnlyAfterAck() = runBlocking {
        val photos = Photos(); val store = Store(photos); store.add(true)
        VanSync(store,Gateway(store),evidence=photos).syncNow()
        assertEquals(listOf("upload","marker","push","ack","delete"),events); assertEquals("done",store.rows.single().status); Unit
    }
    @Test fun failedUploadHoldsOnlyDamageOtherOpsPushAndRetryLater() = runBlocking {
        val photos = Photos(); val store = Store(photos); val damage = store.add(true); val other = store.add()
        val gateway = Gateway(store).apply { failUpload = true }; val sync = VanSync(store,gateway,evidence=photos)
        sync.syncNow(); assertEquals(listOf(listOf(other.clientRequestId)),gateway.pushed)
        assertEquals("pending",store.rows.single { it.clientRequestId == damage.clientRequestId }.status)
        assertFalse(photos.stored); assertFalse(photos.deleted); assertEquals("retry_pending",store.health)
        gateway.failUpload = false; sync.syncNow()
        assertEquals(listOf(damage.clientRequestId),gateway.pushed.last()); assertTrue(photos.deleted); Unit
    }
    @Test fun failedFirst20PhotosDoNotStarveLaterOperations() = runBlocking {
        val photos = Photos(); val store = Store(photos); repeat(20) { store.add(true) }; val other = store.add()
        val gateway = Gateway(store).apply { failUpload = true }
        VanSync(store,gateway,evidence=photos).syncNow()
        assertEquals(listOf(listOf(other.clientRequestId)),gateway.pushed); assertEquals(20,store.pending().size)
        assertEquals(1,events.count { it == "upload" }); Unit
    }
    @Test fun uploadedMarkerSurvivesFailedPushAndSamePhotoIsNotUploadedTwice() = runBlocking {
        val photos = Photos(); val store = Store(photos); store.add(true); store.add(true)
        val gateway = Gateway(store).apply { failPush = true }; val sync = VanSync(store,gateway,evidence=photos)
        assertTrue(runCatching { sync.syncNow() }.isFailure); assertTrue(photos.stored); assertFalse(photos.deleted)
        val bytes = store.rows.map { it.operationJson }; gateway.failPush = false; sync.syncNow()
        assertEquals(bytes,store.rows.map { it.operationJson }); assertEquals(1,events.count { it == "upload" }); assertTrue(photos.deleted); Unit
    }
    @Test fun partitionHoldAfterUploadPreventsMarkerPushAndDeletion() = runBlocking {
        val photos = Photos(); val store = Store(photos); store.add(true)
        val gateway = Gateway(store).apply { holdDuringUpload = true }
        assertTrue(runCatching { VanSync(store,gateway,evidence=photos).syncNow() }.isFailure)
        assertFalse(photos.stored); assertFalse(photos.deleted); assertTrue(gateway.pushed.isEmpty()); Unit
    }
    @Test fun cancellationDuringUploadLeavesPhotoAndOperationPending() = runBlocking {
        val photos = Photos(); val store = Store(photos); store.add(true)
        val gateway = Gateway(store).apply { cancelUpload = true }
        assertTrue(runCatching { VanSync(store,gateway,evidence=photos).syncNow() }.exceptionOrNull() is CancellationException)
        assertFalse(photos.stored); assertFalse(photos.deleted); assertEquals("pending",store.rows.single().status); Unit
    }
}
