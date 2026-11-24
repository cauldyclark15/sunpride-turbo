package com.sunpride.field.census

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.storage.*
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64
import java.util.UUID

/** F-011 real SQLCipher Room proof, without impersonating GPS or camera acceptance. */
@RunWith(AndroidJUnit4::class)
class CensusStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: StoreDatabase
    private val scope = StoreScope("census-${UUID.randomUUID()}", "census-device", "census-scope")
    private fun store() = RoomFieldStore(db, scope)
    @Before fun open() { db = EncryptedFieldDatabase.open(context) }
    @After fun close() { db.close() }
    private fun payload() = JSONObject().put("captureId", UUID.randomUUID().toString()).put("batchId", UUID.randomUUID().toString())
        .put("channelId", UUID.randomUUID().toString()).put("subchannelId", UUID.randomUUID().toString())
        .put("name", "F-011 encrypted census marker").put("address", "Sample address")
        .put("ownerName", "Sample owner").put("ownerPhone", "09171234567").put("estimatedClass", "D").put("deviceTime", 1000L)
        .put("location", JSONObject().put("latitude", 10.32).put("longitude", 123.9).put("accuracyMeters", 12)
            .put("fixTime", 1000L).put("provider", "gps").put("mockSignal", false))
        .put("photoJpegBase64", Base64.getEncoder().encodeToString(byteArrayOf(0xff.toByte(), 0xd8.toByte(), 0xff.toByte(), 0xd9.toByte())))
    @Test fun f011OfflineCaptureSurvivesReopenAndHeldScopeWithoutLosingPhotoBytes() = runBlocking {
        val store = store()
        val snapshot = ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList())
        store.swap(store.stage(snapshot), "census-cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        assertNotNull(store.censusCacheGrant(scope,1000))
        assertNull(store.censusCacheGrant(scope.copy(fingerprint="another-scope"),1000))
        val intent = CensusRules.intent(scope, payload(), 1000)
        store.enqueue(intent, 1000)
        db.close(); db = EncryptedFieldDatabase.open(context)
        assertEquals(intent.serializedOperation, store().pending().single().first.serializedOperation)
        store().purgeCacheForReview()
        // The shared v2 engine holds the partition, not each retained outbox row.
        assertTrue(store().isHeld()); assertFalse(store().isLeaseValid(1001))
        assertNull(store().censusCacheGrant(scope,1001))
        assertThrows(IllegalStateException::class.java) { runBlocking {
            store().enqueue(CensusRules.intent(scope,payload(),1001),1001)
        } }
        assertEquals(intent.serializedOperation, store().history().single().first.serializedOperation)
        assertEquals("pending", store().history().single().second.state)
        val disk = context.getDatabasePath(PassphraseVault.DB_NAME).readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(disk.contains("F-011 encrypted census marker"))
        Unit
    }
    @Test fun customerDraftBookSurvivesEncryptedReopenAndBootstrapAndIsPartitioned() = runBlocking {
        val target = store()
        val snapshot = ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList())
        target.swap(target.stage(snapshot), "draft-cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val draft = CustomerCapture.Draft(CustomerCapture.Form(customerName = "SP244 private draft marker"), null, null)
        val book = CustomerDrafts().save(draft).save(draft.copy(form = CustomerCapture.Form()))
        target.putLocalCache("local.customerdraft", "draft", book.json()!!, 1001, "draft")
        assertTrue(target.pending().isEmpty()) // not a submitted customer
        db.close(); db = EncryptedFieldDatabase.open(context)
        val reopened = store()
        reopened.swap(reopened.stage(snapshot), "new-cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        assertEquals(2, CustomerDrafts.parse(reopened.localCache("local.customerdraft", "draft")!!.json).saved.size)
        assertNull(RoomFieldStore(db, scope.copy(account = "other")).localCache("local.customerdraft", "draft"))
        assertNull(RoomFieldStore(db, scope.copy(fingerprint = "other")).localCache("local.customerdraft", "draft"))
        val disk = context.getDatabasePath(PassphraseVault.DB_NAME).readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(disk.contains("SP244 private draft marker"))
        Unit
    }

    @Test fun finalSaveAndDraftRemovalCommitOrRollBackTogether() = runBlocking {
        val target = store()
        val snapshot = ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList())
        target.swap(target.stage(snapshot), "draft-cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        val draft = CustomerCapture.Draft(CustomerCapture.Form(), null, null)
        val book = CustomerDrafts().save(draft).save(draft)
        val original = book.json()!!
        target.putLocalCache("local.customerdraft", "draft", original, 1001, "draft")
        val intent = CensusRules.intent(scope, payload(), 1002)
        // Simulate failure updating the draft record AFTER enqueue: the intent/outbox must roll back too.
        assertThrows(IllegalArgumentException::class.java) { runBlocking { target.enqueueCustomerCapture(intent, "", 1002) } }
        assertTrue(target.pending().isEmpty())
        assertEquals(original, target.localCache("local.customerdraft", "draft")!!.json)
        val remaining = book.open(book.saved.first().id).clear().json()
        target.enqueueCustomerCapture(intent, remaining, 1003)
        db.close(); db = EncryptedFieldDatabase.open(context)
        assertEquals(intent.serializedOperation, store().pending().single().first.serializedOperation)
        assertEquals(listOf(book.saved.last().id), CustomerDrafts.parse(store().localCache("local.customerdraft", "draft")!!.json).saved.map { it.id })
        Unit
    }

    @Test fun f011CaptureAndOutboxRollbackTogetherAtTheExistingStoreTransactionBoundary() = runBlocking {
        val store = store()
        val snapshot = ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList())
        store.swap(store.stage(snapshot), "census-cursor", Long.MAX_VALUE, Long.MAX_VALUE)
        assertNotNull(store.censusCacheGrant(scope,1000))
        assertNull(store.censusCacheGrant(scope.copy(fingerprint="another-scope"),1000))
        val intent = CensusRules.intent(scope, payload(), 1000)
        assertThrows(IllegalStateException::class.java) { runBlocking { store.enqueueWithCheckpoint(intent, 1000) { error("Injected failure") } } }
        assertTrue(store.pending().isEmpty()); assertNull(store.intent(intent.requestId))
        Unit
    }
}
