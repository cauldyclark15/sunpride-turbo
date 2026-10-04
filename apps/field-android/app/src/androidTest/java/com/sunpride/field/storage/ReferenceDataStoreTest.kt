package com.sunpride.field.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.sync.SignedVisitGateway
import com.sunpride.field.sync.VisitSync
import com.sunpride.field.sync.VisitTransport
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

/** Real SQLCipher/Room promotion, revisions, call-sheet projection and cursor atomicity. */
@RunWith(AndroidJUnit4::class)
class ReferenceDataStoreTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val scope = StoreScope("issuer|reference-${UUID.randomUUID()}", "reference-device", "reference-scope")
    private lateinit var db: StoreDatabase
    private fun store(id: StoreScope = scope) = RoomFieldStore(db, id)
    private val product = CatalogProduct("p", "SKU", "SQLCipher reference marker", "CAN", 1759550000000L,
        1000, ProductUom("CAN", "Can", 0), listOf(SellingUom("CS", "Case", 0, UomConversion(48000, 1, "exact"))),
        listOf(ProductBarcode("first", "CAN"), ProductBarcode("second", null)))
    private val stock = InventoryAvailability("balance", "p", "loc", "BR-MNL-01", "Branch", 24000, 30000, 6000,
        1759550000123L, 1759550000123L)
    private val sheet = CallSheet("o", 10, CallSheetHeader("Account", null, null, null, null, null, null, null, null, "header-price"),
        listOf(CallSheetProduct("p", "OLD", "Old", "PC", "old", "line-price"),
            CallSheetProduct("untouched", "U", "Other", "PC", null, null)))
    private fun snapshot() = ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList(),
        listOf(sheet, sheet.copy(outletId = "o2")), productCatalog = listOf(product), inventoryAvailability = listOf(stock))
    private fun delta(p: CatalogProduct) = DeltaRow(scope.account, scope.deviceId, scope.fingerprint,
        "product", p.id, p.revision, ReferenceDataCodec.encode(p).toString(), false)
    private fun delta(i: InventoryAvailability) = DeltaRow(scope.account, scope.deviceId, scope.fingerprint,
        "inventory", i.id, i.revision, ReferenceDataCodec.encode(i).toString(), false)
    private suspend fun ready() { store().swap(store().stage(snapshot()), "before", Long.MAX_VALUE, Long.MAX_VALUE) }
    private fun reopen() { db.close(); db = EncryptedFieldDatabase.open(context) }
    @Before fun open() { db = EncryptedFieldDatabase.open(context) }
    @After fun close() { db.close() }

    @Test fun stagedReferencesPromoteTogetherPersistEncryptedAndDoNotLeakPartitions() = runBlocking {
        val generation = store().stage(snapshot())
        assertTrue(store().catalog().isEmpty()); assertTrue(store().availability("p").isEmpty())
        store().swap(generation, "before", Long.MAX_VALUE, Long.MAX_VALUE)
        for (id in listOf(scope.copy(account = "other"), scope.copy(deviceId = "other"), scope.copy(fingerprint = "other"))) {
            val other = store(id)
            other.swap(other.stage(snapshot()), "other", Long.MAX_VALUE, Long.MAX_VALUE)
            assertEquals(listOf(product), other.catalog())
            assertEquals(listOf(stock), other.availability("p"))
            store().applyDelta(listOf(delta(product.copy(name = "Scoped rename"))), "rename")
            assertEquals(product, other.catalog().single()); assertEquals("Old", other.callSheet("o")!!.lines.first().name)
        }
        reopen()
        assertEquals("Scoped rename", store().catalog().single().name)
        assertEquals(stock, store().availability("p").single()); assertTrue(store().availability("other").isEmpty())
        assertEquals("rename", store().cursor())
        val bytes = context.getDatabasePath(PassphraseVault.DB_NAME).readBytes().toString(Charsets.ISO_8859_1)
        assertFalse(bytes.contains(product.name)); assertFalse(bytes.startsWith("SQLite format"))
        val next = store().stage(snapshot().copy(productCatalog = emptyList(), inventoryAvailability = emptyList()))
        assertEquals(1, store().catalog().size)
        assertThrows(IllegalStateException::class.java) { runBlocking { store().swap("missing", "bad", 2000, 2000) } }
        assertEquals("rename", store().cursor())
        store().swap(next, "empty-snapshot", Long.MAX_VALUE, Long.MAX_VALUE)
        reopen()
        assertTrue(store().catalog().isEmpty()); assertTrue(store().availability("p").isEmpty())
        assertNull(store().delta("product", "p")); assertNull(store().delta("inventory", "balance"))
        Unit
    }

    @Test fun referenceRevisionGuardsUseBootstrapAndEqualRevisionRefreshesAllLinesWithoutChangingPricing() = runBlocking {
        ready()
        val queued = IntentRow(scope.account, scope.deviceId, scope.fingerprint, UUID.randomUUID().toString(), "local",
            "visit.activity", "{\"kind\":\"visit.activity\"}", 100)
        store().enqueue(queued, 100)
        store().applyDelta(listOf(delta(product.copy(revision = product.revision - 1, name = "Stale")),
            delta(stock.copy(revision = stock.revision - 1, availableBase = 1))), "stale-page")
        assertEquals(product, store().catalog().single()); assertEquals(stock, store().availability("p").single())
        assertEquals("Old", store().callSheet("o")!!.lines.first().name)
        val updated = product.copy(code = "NEW", name = "New name", uom = "CS")
        val availability = stock.copy(availableBase = 99)
        store().applyDelta(listOf(delta(updated), delta(availability)), "equal-page")
        reopen()
        assertEquals(updated, store().catalog().single()); assertEquals(availability, store().availability("p").single())
        assertEquals("equal-page", store().cursor())
        for (outlet in listOf("o", "o2")) {
            val actual = store().callSheet(outlet)!!
            assertEquals(CallSheetProduct("p", "NEW", "New name", "CS", "first", "line-price"), actual.lines.first())
            assertEquals(sheet.lines.last(), actual.lines.last()); assertEquals(sheet.header, actual.header)
            assertEquals(10L, actual.revision)
        }
        store().applyDelta(listOf(delta(updated.copy(revision = updated.revision + 1, barcodes = emptyList())),
            delta(stock.copy(id = "balance2", locationId = "loc2", locationCode = "BR-MNL-02"))), "newer-page")
        assertNull(store().callSheet("o")!!.lines.first().barcode)
        assertEquals(listOf("balance", "balance2"), store().availability("p").map { it.id })
        assertEquals(queued.serializedOperation, store().pending().single().first.serializedOperation)
        store().applyDelta(emptyList(), "empty-page"); reopen(); assertEquals("empty-page", store().cursor())
        Unit
    }

    /** QSR-010: confirmed revocation drops cached products and stock with the rest of the server cache. */
    @Test fun cachePurgeDropsProductsAndStockForThisPartitionOnly() = runBlocking {
        val other = store(scope.copy(fingerprint = "purge-other"))
        ready(); other.swap(other.stage(snapshot()), "other", Long.MAX_VALUE, Long.MAX_VALUE)
        store().purgeCacheForReview()
        reopen()
        assertTrue(store().catalog().isEmpty()); assertTrue(store().availability("p").isEmpty())
        assertNull(store().delta("product", "p"))
        val kept = store(scope.copy(fingerprint = "purge-other"))
        assertEquals(listOf(product), kept.catalog()); assertEquals(listOf(stock), kept.availability("p"))
        db.query("SELECT (SELECT COUNT(*) FROM catalog_products WHERE account=? AND scope=?) + (SELECT COUNT(*) FROM inventory_availability WHERE account=? AND scope=?)",
            arrayOf(scope.account, scope.fingerprint, scope.account, scope.fingerprint)).use {
            it.moveToFirst(); assertEquals(0, it.getInt(0))
        }
        Unit
    }

    @Test fun productUpsertRefreshesStagedLinesAndNewRowsRespectRevisionReplayOrder() = runBlocking {
        ready()
        val staged = store().stage(snapshot())
        val changed = product.copy(revision = product.revision + 1, name = "Refreshed setup")
        val newer = product.copy(id = "new-product", revision = product.revision + 2, name = "New row")
        store().applyDelta(listOf(delta(newer), delta(newer.copy(revision = newer.revision - 1, name = "stale")),
            delta(changed), delta(stock.copy(id = "new-balance", productId = "new-product"))), "new-rows")
        assertEquals(newer, store().catalog().single { it.id == "new-product" })
        assertEquals(1, store().availability("new-product").size)
        store().swap(staged, "promoted", Long.MAX_VALUE, Long.MAX_VALUE)
        reopen()
        assertEquals("Refreshed setup", store().callSheet("o2")!!.lines.first().name)
        assertEquals(listOf(product), store().catalog()); assertTrue(store().availability("new-product").isEmpty())
        Unit
    }

    @Test fun malformedMixedPageRollsBackCatalogInventoryLinesVisitAndCursor() = runBlocking {
        ready()
        val valid = delta(product.copy(revision = product.revision + 1, name = "Would change"))
        val visit = DeltaRow(scope.account, scope.deviceId, scope.fingerprint, "visit", "v", 1, "{}", false)
        val badRows = listOf(delta(stock).copy(account = "foreign"), delta(stock).copy(entityId = "mismatch"),
            delta(stock).copy(revision = stock.revision + 1), delta(product).copy(tombstone = true, json = null))
        for (bad in badRows) {
            assertThrows(IllegalArgumentException::class.java) { runBlocking {
                store().applyDelta(listOf(visit, valid, delta(stock.copy(availableBase = 1)), bad), "bad")
            } }
            assertEquals(product, store().catalog().single()); assertEquals(stock, store().availability("p").single())
            assertEquals("Old", store().callSheet("o")!!.lines.first().name)
            assertNull(store().delta("visit", "v")); assertEquals("before", store().cursor())
        }
        reopen(); assertEquals("before", store().cursor()); assertEquals(product, store().catalog().single())
        store().holdForReview()
        assertThrows(IllegalStateException::class.java) { runBlocking { store().applyDelta(emptyList(), "held") } }
        assertNull(store().cursor())
        Unit
    }

    @Test fun signedPullCommitsReferenceRowsWithRepeatedSeqAndEmptyPagesDurably() = runBlocking {
        ready()
        val updated = product.copy(revision = product.revision + 1, name = "Imported name")
        val available = stock.copy(revision = stock.revision + 1, availableBase = 22000)
        fun change(row: DeltaRow) = JSONObject().put("seq", 7).put("entity", row.entity).put("id", row.entityId)
            .put("revision", row.revision).put("op", "upsert").put("value", JSONObject(row.json!!))
        fun pull(cursor: String, more: Boolean, rows: JSONArray = JSONArray()) = JSONObject().put("type", "pull.response")
            .put("contractVersion", 1).put("serverTime", 100).put("nextCursor", cursor).put("hasMore", more)
            .put("changes", rows).toString()
        val responses = ArrayDeque(listOf(pull("mid", true, JSONArray().put(change(delta(updated))).put(change(delta(available)))),
            pull("empty", false), pull("final", false)))
        val cursors = mutableListOf<String>()
        val transport = object : VisitTransport {
            override fun challenge(deviceId: String) = UUID.randomUUID().toString() to 60100L
            override fun token(refresh: Boolean) = "test-only"
            override fun post(path: String, bytes: ByteArray, headers: Map<String, String>, bearer: String): Pair<Int, String> {
                assertEquals("/mobile/v1/pull", path)
                cursors += JSONObject(String(bytes)).getString("cursor")
                return 200 to responses.removeFirst()
            }
        }
        val signer = object : DeviceSigner {
            override val publicKeySpki = byteArrayOf(1)
            override val protection = KeyProtection.SOFTWARE
            override fun signDer(message: ByteArray) = byteArrayOf(1)
            override fun sign(message: String) = "test-signature"
        }
        VisitSync(SignedVisitGateway(transport, signer, scope.deviceId, { 0L }), store(), scope,
            bootstrap = { error("unexpected bootstrap") }, now = { 100 }, pause = {}, jitter = { 0 }).sync()
        assertEquals(listOf("before", "mid", "empty"), cursors)
        reopen()
        assertEquals(updated, store().catalog().single()); assertEquals(available, store().availability("p").single())
        assertEquals("Imported name", store().callSheet("o2")!!.lines.first().name)
        assertEquals("final", store().cursor())
        Unit
    }
}
