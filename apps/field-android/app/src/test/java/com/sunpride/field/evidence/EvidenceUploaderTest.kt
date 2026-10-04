package com.sunpride.field.evidence

import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.ConvexFunctionError
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** AND-016: photos upload after the Start ack, retry safely, and never touch the visit outbox. */
class EvidenceUploaderTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private fun fixture(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }
    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 1, 2, 3, 0xFF.toByte(), 0xD9.toByte())

    private class MemoryFiles : PhotoFiles {
        val files = mutableMapOf<String, ByteArray>()
        override fun write(localId: String, bytes: ByteArray) { files[localId] = bytes.copyOf() }
        override fun read(localId: String) = files[localId] ?: error("missing")
        override fun delete(localId: String) { files.remove(localId) }
    }
    private class FakeApi : EvidenceApi {
        val calls = mutableListOf<String>()
        var failUpload: Exception? = null
        var failAttach: Exception? = null
        /** Server-side rows by checksum: a retried attach returns the original ID. */
        val attached = mutableMapOf<String, String>()
        val uploadedBytes = mutableListOf<ByteArray>()
        override fun uploadUrl(visitId: String): Pair<String, String> { calls += "url:$visitId"; return "https://upload/x" to "claim-${calls.size}" }
        override fun upload(url: String, bytes: ByteArray, mime: String): String {
            calls += "upload:$mime"; failUpload?.let { throw it }; uploadedBytes += bytes; return "storage-${calls.size}"
        }
        override fun attach(claim: String, visitId: String, storageId: String, row: EvidencePhotoRow): String {
            calls += "attach:$visitId:${row.photoType}"
            val id = attached.getOrPut(row.sha256) { "evidence-${attached.size + 1}" }
            failAttach?.let { throw it }
            return id
        }
    }

    private suspend fun setup(): Triple<FakeFieldStore, IntentRow, MemoryFiles> {
        val store = FakeFieldStore(scope)
        val snapshot = BootstrapCodec.snapshot(listOf(BootstrapCodec.page(fixture("bootstrap-call-sheet-response.json"))))
            .copy(photoTypes = BootstrapCodec.page(fixture("bootstrap-photo-types-response.json")).photoTypes!!)
        store.swap(store.stage(snapshot), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val outlet = store.outlets().first().id
        val start = VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, null, outlet,
            listOf("sell"), "walk-in", null, null, null, null, at = 100)
        store.enqueue(start, 100)
        return Triple(store, store.history().single().first, MemoryFiles())
    }
    private suspend fun photo(store: FakeFieldStore, files: MemoryFiles, start: IntentRow, type: String = "shelf_display",
        bytes: ByteArray = jpeg): EvidencePhotoRow {
        val row = EvidencePhotoRow(scope.account, scope.deviceId, scope.fingerprint, UUID.randomUUID().toString(),
            start.clientVisitId, start.requestId, "outlet", type, EvidencePhotos.MIME, bytes.size.toLong(),
            EvidencePhotos.sha256Hex(bytes), 150, 150L + store.photos.size)
        files.write(row.localId, bytes)
        store.addPhoto(row, 200)
        return row
    }

    @Test fun waitsForTheStartAckThenUploadsAndDeletesThePhoneCopy() = runBlocking {
        val (store, start, files) = setup()
        val row = photo(store, files, start)
        val api = FakeApi()
        val first = EvidenceUploader(store, scope, files, api).run()
        assertEquals(UploadReport(waiting = 1, retryLater = true), first)
        assertTrue(api.calls.isEmpty())
        store.recordAck(start.requestId, "visit-server-1", "[]", 300)
        val second = EvidenceUploader(store, scope, files, api, now = { 400 }).run()
        assertEquals(1, second.uploaded); assertFalse(second.retryLater); assertEquals(0, second.waiting)
        assertEquals(listOf("url:visit-server-1", "upload:image/jpeg", "attach:visit-server-1:shelf_display"), api.calls)
        assertArrayEquals(jpeg, api.uploadedBytes.single())
        val saved = store.visitPhotos(start.clientVisitId).single()
        assertEquals("uploaded", saved.state); assertEquals("evidence-1", saved.evidenceId); assertEquals(400L, saved.uploadedAt)
        assertFalse(files.files.containsKey(row.localId))
        // The visit outbox is untouched by photo upload.
        assertEquals(listOf("done"), store.history().map { it.second.state })
    }

    @Test fun offlineKeepsThePhotoPendingAndALostAttachResponseResolvesToTheSameRow() = runBlocking {
        val (store, start, files) = setup()
        val row = photo(store, files, start)
        store.recordAck(start.requestId, "visit-server-1", "[]", 300)
        val api = FakeApi().apply { failUpload = AuthFailure(AuthFailure.Kind.OFFLINE) }
        val offline = EvidenceUploader(store, scope, files, api).run()
        assertTrue(offline.retryLater); assertEquals(1, offline.waiting)
        assertEquals("pending", store.visitPhotos(start.clientVisitId).single().state)
        assertEquals(0, store.visitPhotos(start.clientVisitId).single().attempts)
        // The server attaches, but the response is lost.
        api.failUpload = null; api.failAttach = AuthFailure(AuthFailure.Kind.OFFLINE)
        assertTrue(EvidenceUploader(store, scope, files, api).run().retryLater)
        assertTrue(files.files.containsKey(row.localId))
        api.failAttach = null
        val done = EvidenceUploader(store, scope, files, api).run()
        assertEquals(1, done.uploaded)
        assertEquals(1, api.attached.size)
        assertEquals("evidence-1", store.visitPhotos(start.clientVisitId).single().evidenceId)
    }

    @Test fun finalRefusalsGoToReviewAndRepeatedFailuresStopAfterTheLimit() = runBlocking {
        val (store, start, files) = setup()
        val refused = photo(store, files, start)
        store.recordAck(start.requestId, "visit-server-1", "[]", 300)
        val api = FakeApi().apply { failAttach = ConvexFunctionError("out_of_scope") }
        val report = EvidenceUploader(store, scope, files, api).run()
        assertEquals(1, report.review)
        assertEquals("out_of_scope", store.visitPhotos(start.clientVisitId).single { it.localId == refused.localId }.reviewCode)
        // A refused storage upload is retried, then handed to the office after MAX_ATTEMPTS.
        val flaky = photo(store, files, start, "price_tag", jpeg + byteArrayOf(9))
        api.failAttach = null; api.failUpload = EvidenceUploadFailure()
        repeat(EvidencePhotos.MAX_ATTEMPTS - 1) { assertTrue(EvidenceUploader(store, scope, files, api).run().retryLater) }
        assertEquals("pending", store.visitPhotos(start.clientVisitId).single { it.localId == flaky.localId }.state)
        val last = EvidenceUploader(store, scope, files, api).run()
        assertEquals(1, last.review); assertFalse(last.retryLater)
        assertEquals("upload_failed", store.visitPhotos(start.clientVisitId).single { it.localId == flaky.localId }.reviewCode)
    }

    @Test fun damagedFilesRejectedStartsAndHeldPartitionsNeverUpload() = runBlocking {
        val (store, start, files) = setup()
        val row = photo(store, files, start)
        store.recordAck(start.requestId, "visit-server-1", "[]", 300)
        files.files[row.localId] = jpeg + byteArrayOf(0) // tampered on disk
        val api = FakeApi()
        assertEquals(1, EvidenceUploader(store, scope, files, api).run().review)
        assertEquals("file_damaged", store.visitPhotos(start.clientVisitId).single().reviewCode)
        assertTrue(api.calls.isEmpty())

        val (other, otherStart, otherFiles) = setup()
        photo(other, otherFiles, otherStart)
        other.recordRejection(otherStart.requestId, "call_open")
        assertEquals(1, EvidenceUploader(other, scope, otherFiles, api).run().review)
        assertEquals("visit_rejected", other.visitPhotos(otherStart.clientVisitId).single().reviewCode)

        val (held, heldStart, heldFiles) = setup()
        photo(held, heldFiles, heldStart)
        held.recordAck(heldStart.requestId, "visit-server-2", "[]", 300)
        held.holdForReview()
        assertEquals(UploadReport(waiting = 1), EvidenceUploader(held, scope, heldFiles, api).run())
        assertTrue(api.calls.isEmpty())
    }
}
