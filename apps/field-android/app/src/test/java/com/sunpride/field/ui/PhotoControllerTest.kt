package com.sunpride.field.ui

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID
import kotlin.coroutines.EmptyCoroutineContext

/** AND-016: photos through the controller — open call only, saved offline, End never waits for upload. */
class PhotoControllerTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private val signer = object : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private val jpeg = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 7, 0xFF.toByte(), 0xD9.toByte())
    private fun fixture(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }

    private inner class Backend(val store: FakeFieldStore) : FieldBackend {
        val sealed = mutableMapOf<String, ByteArray>()
        override val isSignedIn = true
        override val cachedDeviceId = scope.deviceId
        override fun loadSigner() = signer
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(scope.deviceId)
        override fun visitStates() = runBlocking { store.history().map { it.first to it.second.state } }
        override fun callSheet(outletId: String) = runBlocking { store.callSheet(outletId) }
        override fun activityRules() = runBlocking { store.activityRules() }
        override fun photoTypes() = runBlocking { store.photoTypes() }
        override fun visitPhotos(clientVisitId: String) = runBlocking { store.visitPhotos(clientVisitId).map { EvidencePhotos.view(it) } }
        override fun savePhoto(clientVisitId: String, checkInRequestId: String, outletId: String, photoType: String,
            jpeg: ByteArray, capturedAt: Long) = runBlocking {
            val id = UUID.randomUUID().toString()
            sealed[id] = jpeg
            store.addPhoto(EvidencePhotoRow(scope.account, scope.deviceId, scope.fingerprint, id, clientVisitId,
                checkInRequestId, outletId, photoType, EvidencePhotos.MIME, jpeg.size.toLong(),
                EvidencePhotos.sha256Hex(jpeg), capturedAt, 100), 100)
        }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) = runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, kind, clientVisitId, checkInRequestId, previousRequestId,
                plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode, location, at = 100), 100)
        }
    }

    private suspend fun kotlinx.coroutines.CoroutineScope.controller(): Triple<FieldController, FakeFieldStore, Backend> {
        val store = FakeFieldStore(scope)
        val snapshot = BootstrapCodec.snapshot(listOf(BootstrapCodec.page(fixture("bootstrap-call-sheet-response.json"))))
            .copy(photoTypes = BootstrapCodec.page(fixture("bootstrap-photo-types-response.json")).photoTypes!!)
        store.swap(store.stage(snapshot), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val backend = Backend(store)
        return Triple(FieldController(backend, this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L }), store, backend)
    }

    @Test fun photosNeedAnOpenCallSaveOfflineAndNeverHoldUpEnd() = runBlocking {
        val (c, store, backend) = controller()
        val outlet = store.outlets().first().id
        val visit = VisitDisplay("Account", "Unplanned", "Reason required", outlet)
        c.openDiagnostic(visit).join()
        c.openPhotoCapture().join()
        assertFalse(c.photoCaptureOpen)
        assertEquals(VisitRuleFailure.Code.CALL_NOT_OPEN, c.diagnosticFailure)
        c.toggleIntent("sell").join()
        c.queueDiagnostic("visit.checkIn", "walk-in", null, null, null).join()
        assertNull(c.diagnosticError)
        assertEquals(listOf("storefront", "shelf_display", "price_tag", "promotion", "other"), c.photoTypeChoices().map { it.code })
        c.openPhotoCapture().join()
        assertTrue(c.photoCaptureOpen)
        c.savePhoto("selfie", jpeg, 90).join()
        assertEquals("Could not save this photo. Try again.", c.diagnosticError)
        assertTrue(store.photos.isEmpty())
        var saved = false
        c.savePhoto("shelf_display", jpeg, 90) { saved = true }.join()
        assertTrue(saved); assertFalse(c.photoCaptureOpen); assertNull(c.diagnosticError)
        val row = store.photos.single()
        val start = store.history().single().first
        assertEquals(listOf(start.clientVisitId, start.requestId, "shelf_display", "image/jpeg"),
            listOf(row.clientVisitId, row.checkInRequestId, row.photoType, row.mime))
        assertEquals(90L, row.capturedAt); assertEquals(jpeg.size.toLong(), row.sizeBytes)
        assertEquals(EvidencePhotos.sha256Hex(jpeg), row.sha256)
        assertEquals(listOf("pending"), c.diagnosticPhotos.map { it.state })
        // A photo is evidence, not a visit operation: the outbox holds only the Start.
        assertEquals(listOf("visit.checkIn"), store.history().map { it.first.kind })
        // Nothing uploaded (offline) and End still goes through.
        c.reviewEnd("nonproductive", "closed").join()
        assertNotNull(c.endReview)
        c.queueDiagnostic("visit.checkOut", "closed", null, "nonproductive", null).join()
        assertNull(c.diagnosticFailure)
        assertEquals(listOf("visit.checkIn", "visit.checkOut"), store.history().map { it.first.kind })
        assertEquals("1 photo · 1 waiting to upload", EvidencePhotos.summary(c.diagnosticPhotos))
        // After End: no new photos, the saved one stays queued for upload.
        c.openPhotoCapture().join()
        assertFalse(c.photoCaptureOpen)
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, c.diagnosticFailure)
        c.savePhoto("other", jpeg + byteArrayOf(1), 95).join()
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, c.diagnosticFailure)
        assertEquals(1, store.pendingPhotos().size)
        assertEquals(1, backend.sealed.size)
    }
}
