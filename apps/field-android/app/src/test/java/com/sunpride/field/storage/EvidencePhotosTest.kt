package com.sunpride.field.storage

import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.sync.WireFailure
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.syncstatus.SyncStatus
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** AND-016: configured photo types, local photo metadata rules and the photo status copy. */
class EvidencePhotosTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private fun fixture(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().use { it.readText() }

    @Test fun bootstrapCarriesConfiguredTypesStrictlyAndOlderServersFallBackToDefaults() {
        val page = BootstrapCodec.page(fixture("bootstrap-photo-types-response.json"))
        assertEquals(listOf("storefront", "shelf_display", "price_tag", "promotion", "other"), page.photoTypes!!.map { it.code })
        assertEquals("Shelf and display", page.photoTypes!![1].label)
        assertEquals(page.photoTypes, BootstrapCodec.snapshot(listOf(page)).photoTypes)
        val older = BootstrapCodec.page(fixture("bootstrap-activity-rules-response.json"))
        assertNull(older.photoTypes)
        assertEquals(EvidencePhotos.DEFAULT_TYPES, EvidencePhotos.offered(BootstrapCodec.snapshot(listOf(older)).photoTypes))
        fun mutate(block: (JSONObject) -> Unit) = JSONObject(fixture("bootstrap-photo-types-response.json")).also(block).toString()
        for (bad in listOf(
            mutate { it.getJSONArray("photoTypes").getJSONObject(0).put("required", true) },
            mutate { it.getJSONArray("photoTypes").getJSONObject(0).put("code", "Bad Code") },
            mutate { it.getJSONArray("photoTypes").getJSONObject(0).remove("label") },
            mutate { it.getJSONArray("photoTypes").put(JSONObject().put("code", "other").put("label", "Again")) },
        )) assertThrows(WireFailure::class.java) { BootstrapCodec.page(bad) }
    }

    @Test fun jpegChecksAndChecksumsMatchTheServerFormat() {
        assertTrue(EvidencePhotos.isJpeg(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0, 0xFF.toByte(), 0xD9.toByte())))
        assertFalse(EvidencePhotos.isJpeg("not a jpeg".toByteArray()))
        // Same vector as the backend's matchesChecksum test ("hello").
        assertEquals("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
            EvidencePhotos.sha256Hex("hello".toByteArray()))
    }

    @Test fun photosNeedAnOpenCallAConfiguredTypeAndStopAtTheLimit() = runBlocking {
        val store = FakeFieldStore(scope)
        val snapshot = BootstrapCodec.snapshot(listOf(BootstrapCodec.page(fixture("bootstrap-call-sheet-response.json"))))
            .copy(photoTypes = listOf(PhotoType("shelf_display", "Shelf")))
        store.swap(store.stage(snapshot), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val outlet = store.outlets().first().id
        store.enqueue(VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, null, outlet,
            listOf("sell"), "walk-in", null, null, null, null, at = 100), 100)
        val start = store.history().single().first
        fun row(type: String = "shelf_display", call: String = start.clientVisitId) = EvidencePhotoRow(scope.account,
            scope.deviceId, scope.fingerprint, UUID.randomUUID().toString(), call, start.requestId, outlet, type,
            EvidencePhotos.MIME, 10, "a".repeat(64), 150, 150)
        // Only the downloaded list is offered once one exists; defaults are not mixed in.
        assertThrows(IllegalArgumentException::class.java) { runBlocking { store.addPhoto(row("storefront"), 200) } }
        assertThrows(VisitRuleFailure::class.java) { runBlocking { store.addPhoto(row(call = "other-call"), 200) } }
        repeat(EvidencePhotos.MAX_PER_VISIT) { store.addPhoto(row(), 200) }
        val limit = assertThrows(VisitRuleFailure::class.java) { runBlocking { store.addPhoto(row(), 200) } }
        assertEquals(VisitRuleFailure.Code.PHOTO_LIMIT, limit.code)
        // After End is queued, no more photos; the saved ones remain and still upload.
        store.photos.removeAt(0)
        store.enqueue(VisitIntentFactory.create(scope, "visit.checkOut", start.clientVisitId, start.requestId,
            start.requestId, null, outlet, emptyList(), null, null, "nonproductive", "closed", null, at = 300), 300)
        val ended = assertThrows(VisitRuleFailure::class.java) { runBlocking { store.addPhoto(row(), 400) } }
        assertEquals(VisitRuleFailure.Code.ALREADY_ENDED, ended.code)
        assertEquals(EvidencePhotos.MAX_PER_VISIT - 1, store.pendingPhotos().size)
    }

    @Test fun statusAndSummaryNeverCallWaitingPhotosAllSynced() {
        val synced = SyncStatus(lastSuccess = 1, leaseExpiresAt = Long.MAX_VALUE, cacheExpiresAt = Long.MAX_VALUE, health = "synced")
        assertEquals("All synced", synced.label(10))
        assertEquals("Visits synced · photos uploading", synced.copy(photosWaiting = 2).label(10))
        val photos = listOf(VisitPhoto("1", "shelf_display", 1, 1, "uploaded"), VisitPhoto("2", "other", 1, 1, "pending"),
            VisitPhoto("3", "other", 1, 1, "review", "out_of_scope"))
        assertEquals("3 photos · 1 waiting to upload · 1 for office review", EvidencePhotos.summary(photos))
        assertNull(EvidencePhotos.summary(emptyList()))
        assertEquals("Saved on phone · uploads when online", EvidencePhotos.stateLabel(photos[1]))
        assertEquals("Shelf and display", EvidencePhotos.label("shelf_display", emptyList()))
    }
}
