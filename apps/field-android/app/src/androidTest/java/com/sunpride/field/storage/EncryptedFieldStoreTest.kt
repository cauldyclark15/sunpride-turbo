package com.sunpride.field.storage

import androidx.room.Room
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.MainActivity
import kotlinx.coroutines.runBlocking
import net.zetetic.database.sqlcipher.SupportOpenHelperFactory
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class EncryptedFieldStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: StoreDatabase
    private val scope = StoreScope("issuer|person-${UUID.randomUUID()}", "device-A", "scope-A")
    private fun store(id: StoreScope = scope) = RoomFieldStore(db, id)
    private fun item(text: String = "visit") = SnapshotItem("visit-1", text, "2026-09-26")
    private fun snapshot(text: String = "visit") = ScopedSnapshot("{\"id\":\"employee\"}", null,
        listOf(item(text)), listOf(SnapshotItem("outlet-1", "outlet")), emptyList(), emptyList())
    private fun intent(request: String = UUID.randomUUID().toString()) = IntentRow(scope.account, scope.deviceId,
        scope.fingerprint, request, UUID.randomUUID().toString(), "visit.checkIn", "{\"kind\":\"visit.checkIn\"}", 123L)
    private suspend fun ready(store: RoomFieldStore, text: String = "visit") {
        store.swap(store.stage(snapshot(text)), "opaque-cursor", 2000, 2000)
    }

    @Before fun open() { db = EncryptedFieldDatabase.open(context) }
    @After fun close() { db.close() }

    @Test fun wrappedKeyPersistsAndCiphertextContainsNoMarkerAndWrongKeyFails() = runBlocking {
        val marker = "KNOWN_PLAINTEXT_MARKER_${UUID.randomUUID()}"
        ready(store(), marker)
        db.close()
        val bytes = context.getDatabasePath(PassphraseVault.DB_NAME).readBytes()
        assertFalse(bytes.toString(Charsets.ISO_8859_1).contains(marker))
        assertFalse(bytes.copyOfRange(0, minOf(bytes.size, 16)).toString(Charsets.US_ASCII).contains("SQLite format"))
        for (suffix in listOf("-wal", "-shm")) {
            val file = context.getDatabasePath(PassphraseVault.DB_NAME + suffix)
            if (file.exists()) assertFalse(file.readBytes().toString(Charsets.ISO_8859_1).contains(marker))
        }
        System.loadLibrary("sqlcipher")
        val wrong = Room.databaseBuilder(context, StoreDatabase::class.java, PassphraseVault.DB_NAME)
            .openHelperFactory(SupportOpenHelperFactory("definitely-the-wrong-passphrase".toByteArray())).build()
        try {
            assertThrows(Exception::class.java) { wrong.openHelper.writableDatabase }
        } finally { wrong.close() }
        db = EncryptedFieldDatabase.open(context)
        assertEquals(marker, store().todaysVisits("2026-09-26").single().json)
    }

    @Test fun sameAccountVerifiedSwapReleasesHeldButOtherAccountCannotSeeIt() = runBlocking {
        ready(store())
        val i = intent()
        store().enqueue(i, 100)
        store().holdForReview()
        assertNull(store().cursor())
        val other = store(scope.copy(account = "issuer|different"))
        assertTrue(other.pending().isEmpty())
        assertTrue(other.todaysVisits("2026-09-26").isEmpty())
        val staged = store().stage(snapshot("new"))
        assertNull(store().cursor())
        store().swap(staged, "fresh-cursor", 3000, 3000, releaseHeld = true)
        assertEquals("fresh-cursor", store().cursor())
        assertEquals(i.requestId, store().pending().single().first.requestId)
        assertTrue(store().isLeaseValid(100))
        assertTrue(other.pending().isEmpty())
    }

    @Test fun rollbackLeavesNeitherIntentNorOutbox() = runBlocking {
        ready(store())
        val intent = intent()
        assertThrows(IllegalStateException::class.java) {
            runBlocking { store().enqueueWithCheckpoint(intent, 100) { error("crash before outbox") } }
        }
        assertNull(db.rows().intent(scope.account, scope.deviceId, scope.fingerprint, intent.requestId))
        assertTrue(store().pending().isEmpty())
    }

    @Test fun swapAndCursorResetPreservePendingAndDurability() = runBlocking {
        ready(store())
        val i = intent()
        store().enqueue(i, 100)
        val generation = store().stage(snapshot("new"))
        assertEquals("visit", store().todaysVisits("2026-09-26").single().json)
        store().swap(generation, "new-cursor", 3000, 3000)
        store().setCursor(null)
        db.close()
        db = EncryptedFieldDatabase.open(context)
        assertEquals("new", store().todaysVisits("2026-09-26").single().json)
        assertNull(store().cursor())
        assertEquals(i.requestId, store().pending().single().first.requestId)
        assertNotNull(db.rows().intent(scope.account, scope.deviceId, scope.fingerprint, i.requestId))
    }

    @Test fun ackMustPrecedeDoneAndRejectionFreezesPayload() = runBlocking {
        ready(store())
        val i = intent()
        store().enqueue(i, 100)
        assertEquals(0, db.rows().markDone(scope.account, scope.deviceId, scope.fingerprint, i.requestId))
        store().recordAck(i.requestId, "server-visit", "[]", 150)
        assertEquals("server-visit", store().ack(i.requestId)?.entityId)
        assertEquals("done", db.rows().outbox(scope.account, scope.deviceId, scope.fingerprint, i.requestId)?.state)
        assertTrue(store().pending().isEmpty())
        val rejected = intent()
        store().enqueue(rejected, 100)
        store().recordRejection(rejected.requestId, "out_of_scope")
        assertEquals("review", db.rows().outbox(scope.account, scope.deviceId, scope.fingerprint, rejected.requestId)?.state)
        assertEquals(rejected.serializedOperation, db.rows().intent(scope.account, scope.deviceId, scope.fingerprint, rejected.requestId)?.serializedOperation)
    }

    @Test fun partitionsDoNotLeakAndLeaseFailsClosedAndHoldPersists() = runBlocking {
        ready(store())
        val i = intent()
        store().enqueue(i, 100)
        for (other in listOf(StoreScope("issuer|person-B", scope.deviceId, scope.fingerprint),
            StoreScope(scope.account, "device-B", scope.fingerprint),
            StoreScope(scope.account, scope.deviceId, "scope-B"))) {
            assertTrue(store(other).todaysVisits("2026-09-26").isEmpty())
            assertTrue(store(other).pending().isEmpty())
            assertFalse(store(other).isLeaseValid(100))
        }
        assertTrue(store().isLeaseValid(1999))
        assertFalse(store().isLeaseValid(2000))
        assertThrows(IllegalStateException::class.java) { runBlocking { store().enqueue(intent(), 2000) } }
        store().holdForReview()
        assertEquals("held_for_review", store().syncHealth())
        assertFalse(store().isLeaseValid(100))
        assertEquals(i.requestId, store().pending().single().first.requestId)
        assertEquals("visit", store().todaysVisits("2026-09-26").single().json)
        db.close()
        db = EncryptedFieldDatabase.open(context)
        assertEquals(i.requestId, store().pending().single().first.requestId)
    }

    @Test fun signOutHookHoldsEveryPartitionWithoutDeletingUnsentWork() = runBlocking {
        ready(store())
        val i = intent()
        store().enqueue(i, 100)
        db.close()
        EncryptedFieldDatabase.holdExisting(context)
        db = EncryptedFieldDatabase.open(context)
        assertEquals("held_for_review", store().syncHealth())
        assertNull(store().cursor())
        assertEquals(i.requestId, store().pending().single().first.requestId)
        assertThrows(IllegalStateException::class.java) { runBlocking { store().setCursor("new-cursor") } }
        Unit
    }

    @Test fun backupAndDeviceTransferExcludeDatabaseAndWrappedKey() {
        val app = context.applicationInfo
        assertEquals(0, app.flags and android.content.pm.ApplicationInfo.FLAG_ALLOW_BACKUP)
        fun exclusions(resource: Int): Set<Pair<String, String>> {
            val result = mutableSetOf<Pair<String, String>>()
            context.resources.getXml(resource).use { parser ->
                while (parser.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
                    if (parser.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && parser.name == "exclude")
                        result += parser.getAttributeValue(null, "domain") to parser.getAttributeValue(null, "path")
                    parser.next()
                }
            }
            return result
        }
        val required = setOf("database" to ".", "sharedpref" to ".")
        assertTrue(exclusions(com.sunpride.field.R.xml.backup_rules).containsAll(required))
        assertTrue(exclusions(com.sunpride.field.R.xml.data_extraction_rules).containsAll(required))
    }

    @Test fun activityRecreationDoesNotLoseCommittedRows() = runBlocking {
        ready(store())
        val i = intent()
        store().enqueue(i, 100)
        val scenario = androidx.test.core.app.ActivityScenario.launch(MainActivity::class.java)
        try { scenario.recreate() } finally { scenario.close() }
        assertEquals(i.requestId, store().pending().single().first.requestId)
    }
}
