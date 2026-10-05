package com.sunpride.field.sync

import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

class ReferenceDataTest {
    private val scope = StoreScope("issuer|reference", "device-reference", "scope-reference")
    private val product = CatalogProduct("p", "SUNP-001", "Corned Beef", "CAN", 1759550000000L, 1000,
        ProductUom("CAN", "Can", 0), listOf(SellingUom("CS", "Case", 0, UomConversion(48000, 1, "exact")),
            SellingUom("CAN", "Can", 0, null)), listOf(ProductBarcode("4800000000017", "CAN"), ProductBarcode("second", null)))
    private val stock = InventoryAvailability("balance", "p", "loc", "BR-MNL-01", "Manila branch",
        24000, 30000, 6000, 1759550000123L, 1759550000123L)
    private val sheet = CallSheet("o", 5, CallSheetHeader("Account", null, null, null, null, null, null, null, null, "header-price"),
        listOf(CallSheetProduct("p", "OLD", "Old", "PC", "old-barcode", "line-price"),
            CallSheetProduct("untouched", "U", "Other", "PC", null, null)))
    private fun snapshot() = ScopedSnapshot("{}", null, emptyList(), emptyList(), emptyList(), emptyList(),
        listOf(sheet, sheet.copy(outletId = "o2")), productCatalog = listOf(product), inventoryAvailability = listOf(stock))
    private fun delta(p: CatalogProduct) = DeltaRow(scope.account, scope.deviceId, scope.fingerprint,
        "product", p.id, p.revision, ReferenceDataCodec.encode(p).toString(), false)
    private fun delta(i: InventoryAvailability) = DeltaRow(scope.account, scope.deviceId, scope.fingerprint,
        "inventory", i.id, i.revision, ReferenceDataCodec.encode(i).toString(), false)
    private fun envelope(): JSONObject = javaClass.classLoader!!.getResourceAsStream("bootstrap-response.json")!!
        .bufferedReader().use { JSONObject(it.readText()) }
    private fun page(p: CatalogProduct = product, i: InventoryAvailability = stock) = envelope()
        .put("productCatalog", JSONArray().put(ReferenceDataCodec.encode(p)))
        .put("inventoryAvailability", JSONArray().put(ReferenceDataCodec.encode(i)))
    private suspend fun ready(store: FakeFieldStore) { store.swap(store.stage(snapshot()), "before", Long.MAX_VALUE, Long.MAX_VALUE) }

    @Test fun bootstrapOldAndNewCatalogShapesRoundTrip() {
        val modern = BootstrapCodec.page(page().toString())
        assertEquals(product, modern.productCatalog.single())
        assertEquals(stock, modern.inventoryAvailability.single())
        assertEquals(48000L, modern.productCatalog.single().sellingUoms.first().toBase!!.numerator)
        assertNull(modern.productCatalog.single().sellingUoms.last().toBase)
        assertNull(modern.productCatalog.single().barcodes.last().uom)
        val old = envelope().put("productCatalog", JSONArray().put(JSONObject()
            .put("id", "legacy").put("code", "L").put("name", "Legacy").put("uom", "PC")))
        val legacy = BootstrapCodec.page(old.toString()).productCatalog.single()
        assertEquals(CatalogProduct("legacy", "L", "Legacy", "PC"), legacy)
        assertTrue(BootstrapCodec.page(old.toString()).inventoryAvailability.isEmpty())
        val noBase = product.copy(baseUom = null)
        assertEquals(noBase, BootstrapCodec.page(page(noBase).toString()).productCatalog.single())
        assertEquals(JSONObject(page().toString()).toString(),
            JSONObject(String(BootstrapCodec.encode(modern))).toString())
    }

    @Test fun bootstrapRejectsMalformedReferenceDataWithoutIntegerCoercion() {
        val mutations: List<(JSONObject) -> Unit> = listOf(
            { it.put("inventoryAvailability", JSONObject.NULL) },
            { it.getJSONArray("productCatalog").getJSONObject(0).put("revision", 1.5) },
            { it.getJSONArray("productCatalog").getJSONObject(0).put("quantityScale", "1000") },
            { it.getJSONArray("productCatalog").getJSONObject(0).put("quantityScale", 0) },
            { it.getJSONArray("productCatalog").getJSONObject(0).getJSONObject("baseUom").put("decimalPlaces", 0.5) },
            { it.getJSONArray("productCatalog").getJSONObject(0).getJSONArray("sellingUoms")
                .getJSONObject(0).getJSONObject("toBase").put("denominator", 0) },
            { it.getJSONArray("productCatalog").getJSONObject(0).getJSONArray("barcodes").getJSONObject(0).remove("uom") },
            { it.getJSONArray("inventoryAvailability").getJSONObject(0).put("availableBase", "24000") },
            { it.getJSONArray("inventoryAvailability").getJSONObject(0).put("reservedBase", 0.1) },
            { it.getJSONArray("inventoryAvailability").getJSONObject(0).remove("asOf") }
        )
        mutations.forEach { mutate -> val wire = page(); mutate(wire)
            assertThrows(WireFailure::class.java) { BootstrapCodec.page(wire.toString()) }
        }
        val large = stock.copy(availableBase = Long.MAX_VALUE, physicalBase = Long.MIN_VALUE)
        assertEquals(large, BootstrapCodec.page(page(i = large).toString()).inventoryAvailability.single())
    }

    @Test fun referenceModeFirstPageOnlyAndPagedReferenceRowsMerge() {
        assertTrue(JSONObject(String(BootstrapCodec.request("d", "2026-10-04"))).getBoolean("referenceData"))
        assertFalse(JSONObject(String(BootstrapCodec.request("d", "2026-10-04", "continuation"))).has("referenceData"))
        val first = BootstrapCodec.page(page().put("syncCursor", JSONObject.NULL).put("nextPageCursor", "next").toString())
        val final = BootstrapCodec.page(page(product.copy(id = "p2"), stock.copy(id = "balance2", productId = "p2"))
            .put("page", 2).toString())
        val merged = BootstrapCodec.snapshot(listOf(first, final))
        assertEquals(listOf("p", "p2"), merged.productCatalog.map { it.id })
        assertEquals(listOf("balance", "balance2"), merged.inventoryAvailability.map { it.id })
        assertEquals(1, BootstrapCodec.snapshot(listOf(first, BootstrapCodec.page(page().toString()))).productCatalog.size)
        assertThrows(IllegalArgumentException::class.java) {
            BootstrapCodec.snapshot(listOf(first, BootstrapCodec.page(page(product.copy(name = "conflict")).toString())))
        }
        assertThrows(IllegalArgumentException::class.java) {
            BootstrapCodec.snapshot(listOf(first, BootstrapCodec.page(page(i = stock.copy(availableBase = 1)).toString())))
        }
    }

    @Test fun fakeStagesUntilPromotionAndReplacementClearsReferenceProjection() = runBlocking {
        val store = FakeFieldStore(scope)
        val g = store.stage(snapshot())
        assertTrue(store.catalog().isEmpty()); assertTrue(store.availability("p").isEmpty())
        store.swap(g, "before", Long.MAX_VALUE, Long.MAX_VALUE)
        assertEquals(listOf(product), store.catalog()); assertEquals(listOf(stock), store.availability("p"))
        assertTrue(store.availability("other").isEmpty())
        val next = store.stage(snapshot().copy(productCatalog = emptyList(), inventoryAvailability = emptyList()))
        assertEquals(listOf(product), store.catalog())
        store.swap(next, "replacement", Long.MAX_VALUE, Long.MAX_VALUE)
        assertTrue(store.catalog().isEmpty()); assertTrue(store.availability("p").isEmpty())
        assertNull(store.delta("product", "p")); assertNull(store.delta("inventory", "balance"))
        Unit
    }

    @Test fun fakeGuardsAgainstBootstrapRevisionThenAllowsEqualRevisionAndRefreshesAllSheets() = runBlocking {
        val store = FakeFieldStore(scope); ready(store)
        store.applyDelta(listOf(delta(product.copy(revision = product.revision - 1, name = "stale")),
            delta(stock.copy(revision = stock.revision - 1, availableBase = 1))), "stale-page")
        assertEquals(product, store.catalog().single()); assertEquals(stock, store.availability("p").single())
        assertEquals("Old", store.callSheet("o")!!.lines.first().name)
        val changed = product.copy(code = "NEW", name = "Renamed", uom = "CS")
        store.applyDelta(listOf(delta(changed), delta(stock.copy(availableBase = 99))), "equal-page")
        for (outlet in listOf("o", "o2")) {
            val s = store.callSheet(outlet)!!
            assertEquals(CallSheetProduct("p", "NEW", "Renamed", "CS", "4800000000017", "line-price"), s.lines.first())
            assertEquals(sheet.lines.last(), s.lines.last()); assertEquals(sheet.header, s.header); assertEquals(5L, s.revision)
        }
        assertEquals(99L, store.availability("p").single().availableBase)
        store.applyDelta(listOf(delta(changed.copy(revision = changed.revision + 1, barcodes = emptyList()))), "newer-page")
        assertNull(store.callSheet("o")!!.lines.first().barcode)
        store.applyDelta(emptyList(), "empty-page"); assertEquals("empty-page", store.cursor())
        Unit
    }

    @Test fun fakeRefreshesStagedCallSheetLinesAndAcceptsNewRowsWithOrderedRevisionReplay() = runBlocking {
        val store = FakeFieldStore(scope); ready(store)
        val staged = store.stage(snapshot())
        val newer = product.copy(id = "new-product", revision = product.revision + 2, name = "New row")
        val changed = product.copy(revision = product.revision + 1, name = "Refreshed setup")
        store.applyDelta(listOf(delta(newer), delta(newer.copy(revision = newer.revision - 1, name = "stale")),
            delta(changed), delta(stock.copy(id = "new-balance", productId = "new-product"))), "new-rows")
        assertEquals(newer, store.catalog().single { it.id == "new-product" })
        assertEquals(1, store.availability("new-product").size)
        store.swap(staged, "promoted", Long.MAX_VALUE, Long.MAX_VALUE)
        assertEquals("Refreshed setup", store.callSheet("o2")!!.lines.first().name)
        // Promotion replaces reference rows rather than retaining an unscoped delta overlay.
        assertEquals(listOf(product), store.catalog()); assertTrue(store.availability("new-product").isEmpty())
        Unit
    }

    @Test fun fakeRollsBackEntirePageOnBadRowAndRejectsReferenceTombstonesAndMismatchedIdentity() = runBlocking {
        val store = FakeFieldStore(scope); ready(store)
        val valid = delta(product.copy(revision = product.revision + 1, name = "new"))
        val invalid = listOf(delta(stock).copy(account = "foreign"), delta(stock).copy(entityId = "wrong"),
            delta(stock).copy(revision = stock.revision + 1), delta(product).copy(tombstone = true, json = null))
        for (bad in invalid) {
            assertThrows(IllegalArgumentException::class.java) { runBlocking { store.applyDelta(listOf(valid, bad), "bad") } }
            assertEquals(product, store.catalog().single()); assertEquals("Old", store.callSheet("o")!!.lines.first().name)
            assertEquals("before", store.cursor())
        }
        store.holdForReview()
        assertThrows(IllegalStateException::class.java) { runBlocking { store.applyDelta(emptyList(), "held") } }
        assertNull(store.cursor())
        Unit
    }

    @Test fun signedPullAcceptsProductAndInventoryWithRepeatedSeqAndEmptyContinuation() = runBlocking {
        val store = FakeFieldStore(scope); ready(store)
        val updated = product.copy(revision = product.revision + 1, name = "Office rename")
        val inventory = stock.copy(revision = stock.revision + 1, availableBase = 22000)
        val responses = ArrayDeque<String>()
        fun change(row: DeltaRow) = JSONObject().put("entity", row.entity).put("id", row.entityId)
            .put("seq", 7).put("op", "upsert").put("revision", row.revision).put("value", JSONObject(row.json!!))
        fun pull(cursor: String, more: Boolean, rows: JSONArray = JSONArray()) = JSONObject().put("type", "pull.response")
            .put("contractVersion", 1).put("serverTime", 1).put("changes", rows).put("nextCursor", cursor)
            .put("hasMore", more).toString()
        responses.add(pull("mid", true, JSONArray().put(change(delta(updated))).put(change(delta(inventory)))))
        responses.add(pull("empty", false)); responses.add(pull("final", false))
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
        VisitSync(SignedVisitGateway(transport, signer, scope.deviceId, { 0L }), store, scope,
            bootstrap = { error("unexpected bootstrap") }, now = { 100 }, pause = {}, jitter = { 0 }).sync()
        assertEquals(listOf("before", "mid", "empty"), cursors)
        assertEquals("final", store.cursor()); assertEquals(updated, store.catalog().single())
        assertEquals(inventory, store.availability("p").single())
        assertEquals("Office rename", store.callSheet("o")!!.lines.first().name)
        Unit
    }
}
