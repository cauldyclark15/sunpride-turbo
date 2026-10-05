package com.sunpride.field.orders

import com.sunpride.field.auth.EnrollmentState
import com.sunpride.field.device.DeviceSigner
import com.sunpride.field.device.KeyProtection
import com.sunpride.field.storage.*
import com.sunpride.field.support.FakeFieldStore
import com.sunpride.field.sync.BootstrapCodec
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.VisitDisplay
import com.sunpride.field.ui.diagnosticvisit.VisitIntentFactory
import com.sunpride.field.ui.orders.orderAssociation
import com.sunpride.field.ui.saveOrderDraftIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import kotlin.coroutines.EmptyCoroutineContext

class OrderDraftTest {
    private val scope = StoreScope("issuer|person", "device", "scope")
    private val visit = VisitDisplay("Account", "Planned", "Scheduled", "outlet-1", "planned-1", customerCode = "CUST-1")
    private val outletJson = JSONObject().put("id", "outlet-1").put("name", "Outlet One").put("routeId", "route-1")
        .put("customerId", "customer-1").put("territoryId", "territory-1").put("territoryCode", "PASIG-01")

    private fun snapshot(outlet: JSONObject = outletJson): ScopedSnapshot {
        val text = javaClass.classLoader!!.getResourceAsStream("bootstrap-call-sheet-response.json")!!
            .bufferedReader().use { it.readText() }
        return BootstrapCodec.snapshot(listOf(BootstrapCodec.page(text))).copy(
            outlets = listOf(SnapshotItem("outlet-1", outlet.toString())),
            localCustomers = listOf(SnapshotItem("customer-1", JSONObject().put("id", "customer-1").put("code", "CUST-1").toString())))
    }
    private suspend fun ready(snapshot: ScopedSnapshot = snapshot()) = FakeFieldStore(scope).apply {
        swap(stage(snapshot), "cursor", Long.MAX_VALUE, Long.MAX_VALUE)
    }
    private suspend fun checkIn(store: FakeFieldStore): IntentRow =
        VisitIntentFactory.create(scope, "visit.checkIn", null, null, null, "planned-1", "outlet-1", emptyList(),
            null, null, null, null, null, at = 100).also { store.enqueue(it, 100) }
    private fun failure(block: suspend () -> Unit): OrderDraftFailure.Code =
        (runCatching { runBlocking { block() } }.exceptionOrNull() as? OrderDraftFailure
            ?: error("Expected an order draft failure")).code

    @Test fun catalogIsTheAccountSetupAndSearchesCodeNameAndBarcodeOffline() = runBlocking {
        val catalog = OrderCatalog.of(ready().callSheet("outlet-1"))
        assertEquals(listOf("product-1", "product-2"), catalog.map { it.productId })
        assertEquals(listOf("PC", "CAN"), catalog.map { it.uom })
        assertEquals("₱189.00", catalog.first().priceNote)
        assertEquals(catalog, OrderCatalog.search(catalog, "  "))
        assertEquals(listOf("product-2"), OrderCatalog.search(catalog, "hol-010").map { it.productId })
        assertEquals(listOf("product-1"), OrderCatalog.search(catalog, "4800000000017").map { it.productId })
        assertEquals(listOf("product-2"), OrderCatalog.search(catalog, "córned 150").map { it.productId })
        assertEquals(listOf("product-1"), OrderCatalog.search(catalog, "hotdog 1kg").map { it.productId })
        assertTrue(OrderCatalog.search(catalog, "spam").isEmpty())
        assertTrue(OrderCatalog.of(null).isEmpty())
    }

    @Test fun quantityIsAWholeNumberInTheSetupUom() {
        assertNull(OrderDraftRules.quantity(""))
        assertNull(OrderDraftRules.quantity("  "))
        assertEquals(1, OrderDraftRules.quantity("1"))
        assertEquals(99_999, OrderDraftRules.quantity(" 99999 "))
        for (bad in listOf("0", "-1", "1.5", "100000", "1e3", "12a", "٣")) {
            assertThrows(bad, OrderDraftFailure::class.java) { OrderDraftRules.quantity(bad) }
        }
    }

    @Test fun draftAssociatesCustomerVisitTerritoryAndRouteAndCarriesNoPrices() = runBlocking {
        val store = ready()
        val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId,
            listOf("product-2" to 12, "product-1" to 3), now = 500)
        assertEquals(check.clientVisitId, draft.clientVisitId)
        assertEquals(check.requestId, draft.checkInRequestId)
        assertEquals("planned-1", draft.plannedVisitId)
        assertEquals("outlet-1", draft.outletId)
        assertEquals("customer-1", draft.customerId); assertEquals("CUST-1", draft.customerCode)
        assertEquals("territory-1", draft.territoryId); assertEquals("PASIG-01", draft.territoryCode)
        assertEquals("route-1", draft.routeId)
        assertEquals(2L, draft.catalogRevision)
        assertEquals("unavailable", draft.priceAvailability)
        assertEquals(listOf("HOL-010" to "CAN", "SUNP-001" to "PC"), draft.lines.map { it.code to it.uom })
        assertEquals("Customer CUST-1 · Territory PASIG-01", orderAssociation(visit, draft))
        val encoded = OrderDraftCodec.encode(draft)
        assertFalse(encoded.contains("price\"") || encoded.contains("amount") || encoded.contains("total"))
        assertEquals(draft, OrderDraftCodec.decode(encoded))
        // Drafts are local only: the outbox still holds just the check-in.
        assertEquals(listOf("visit.checkIn"), store.history().map { it.first.kind })
        assertEquals(listOf(draft), store.orderDrafts())

        val updated = saveOrderDraftIn(store, draft.draftId, check.clientVisitId, check.requestId,
            listOf("product-1" to 4), now = 900)
        assertEquals(draft.draftId, updated.draftId); assertEquals(500L, updated.createdAt); assertEquals(900L, updated.updatedAt)
        assertEquals(listOf(updated), store.orderDrafts())
        store.discardOrderDraft(draft.draftId)
        assertTrue(store.orderDrafts().isEmpty())
    }

    @Test fun olderServerWithoutTerritoryStillSavesWithNullTerritory() = runBlocking {
        val store = ready(snapshot(JSONObject(outletJson.toString()).apply { remove("territoryId"); remove("territoryCode") }))
        val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 1), 1)
        assertNull(draft.territoryId); assertNull(draft.territoryCode)
        assertEquals("Customer CUST-1", orderAssociation(visit, draft))
    }

    @Test fun refusesWithoutOpenCallAfterEndAndOutsideTheAccountSetup() {
        val store = runBlocking { ready() }
        assertEquals(OrderDraftFailure.Code.CALL_NOT_OPEN, failure {
            saveOrderDraftIn(store, null, "visit", "missing", listOf("product-1" to 1), 1)
        })
        val check = runBlocking { checkIn(store) }
        assertEquals(OrderDraftFailure.Code.CATALOG_CHANGED, failure {
            saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("nationwide-product" to 1), 1)
        })
        assertEquals(OrderDraftFailure.Code.EMPTY, failure {
            saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, emptyList(), 1)
        })
        assertEquals(OrderDraftFailure.Code.INVALID_QUANTITY, failure {
            saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 0), 1)
        })
        runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, "visit.checkOut", check.clientVisitId, check.requestId,
                check.requestId, null, "outlet-1", emptyList(), null, null, "completed", null, null, at = 200), 200)
        }
        assertEquals(OrderDraftFailure.Code.CALL_ENDED, failure {
            saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 1), 1)
        })
        assertTrue(runBlocking { store.orderDrafts() }.isEmpty())
    }

    @Test fun forgedAssociationAndStaleCatalogNeverPersist() = runBlocking {
        val store = ready()
        val check = checkIn(store)
        val draft = OrderDraftRules.build(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 2), 10)
        for (forged in listOf(draft.copy(territoryId = "other"), draft.copy(customerId = "other"),
            draft.copy(outletId = "outlet-2"), draft.copy(routeId = null),
            draft.copy(lines = listOf(draft.lines.single().copy(uom = "CASE"))), draft.copy(priceAvailability = "available"))) {
            assertTrue(runCatching { store.saveOrderDraft(forged, forged.updatedAt) }.isFailure)
        }
        assertTrue(store.orderDrafts().isEmpty())
        assertEquals(OrderDraftFailure.Code.CATALOG_CHANGED, failure { store.saveOrderDraft(draft.copy(catalogRevision = 1), 10) })
        store.saveOrderDraft(draft, 10)
        // The save time is the draft's own time; a mismatched clock never persists.
        assertTrue(runCatching { store.saveOrderDraft(draft.copy(updatedAt = 12), 11) }.isFailure)
        assertTrue(runCatching { store.saveOrderDraft(draft.copy(createdAt = 11), 10) }.isFailure)
        // The office later removes product-1 from the account setup: the saved line is reported stale.
        val sheet = store.callSheet("outlet-1")!!
        assertEquals(listOf("product-1"), OrderDraftRules.staleLines(draft, sheet.copy(lines = sheet.lines.drop(1))).map { it.productId })
        assertTrue(OrderDraftRules.staleLines(draft, sheet).isEmpty())
    }

    @Test fun heldPartitionFreezesDrafts() = runBlocking {
        val store = ready()
        val check = checkIn(store)
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 2), 10)
        store.holdForReview()
        assertEquals(OrderDraftFailure.Code.HELD, failure { store.saveOrderDraft(draft.copy(updatedAt = 20), 20) })
        assertEquals(OrderDraftFailure.Code.HELD, failure { store.discardOrderDraft(draft.draftId) })
        assertEquals(listOf(draft), store.orderDrafts())
    }

    @Test fun openCallCannotTakeNewOrderWorkAfterTheOfflineLeaseExpires() = runBlocking {
        val store = FakeFieldStore(scope).apply { swap(stage(snapshot()), "cursor", 1_000, Long.MAX_VALUE) }
        val check = checkIn(store) // call opened at 100, inside the lease
        val draft = saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 2), 999)
        // The call is still open, but the lease ended at 1,000: no new draft and no edit to the saved one.
        assertEquals(OrderDraftFailure.Code.OFFLINE_EXPIRED, failure {
            saveOrderDraftIn(store, null, check.clientVisitId, check.requestId, listOf("product-1" to 1), 1_000)
        })
        assertEquals(OrderDraftFailure.Code.OFFLINE_EXPIRED, failure {
            saveOrderDraftIn(store, draft.draftId, check.clientVisitId, check.requestId, listOf("product-1" to 5), 5_000)
        })
        // A forged early timestamp on a late save is refused too (draft time must equal save time).
        assertTrue(runCatching { store.saveOrderDraft(draft.copy(updatedAt = 999), 5_000) }.isFailure)
        assertEquals(listOf(draft), store.orderDrafts())
        // A fresh sync renews the lease and editing resumes.
        store.swap(store.stage(snapshot()), "cursor-2", 10_000, Long.MAX_VALUE)
        val renewed = saveOrderDraftIn(store, draft.draftId, check.clientVisitId, check.requestId, listOf("product-1" to 5), 5_000)
        assertEquals(listOf(renewed), store.orderDrafts())
    }

    private val signer = object : DeviceSigner {
        override val publicKeySpki = byteArrayOf(1)
        override val protection = KeyProtection.SOFTWARE
        override fun signDer(message: ByteArray) = byteArrayOf()
        override fun sign(message: String) = message
    }
    private inner class Backend(val store: FakeFieldStore) : FieldBackend {
        override val isSignedIn = true
        override val cachedDeviceId = scope.deviceId
        override fun loadSigner() = signer
        override fun signIn(email: String, password: String) = Unit
        override fun signOut() = Unit
        override fun refreshEnrollment(signer: DeviceSigner) = EnrollmentState.Ready(scope.deviceId)
        override fun visitStates() = runBlocking { store.history().map { it.first to it.second.state } }
        override fun callSheet(outletId: String) = runBlocking { store.callSheet(outletId) }
        override fun orderDrafts() = runBlocking { store.orderDrafts() }
        override fun saveOrderDraft(draftId: String?, clientVisitId: String, checkInRequestId: String,
            quantities: List<Pair<String, Int>>) = runBlocking {
            saveOrderDraftIn(store, draftId, clientVisitId, checkInRequestId, quantities, 100)
        }
        override fun discardOrderDraft(draftId: String) = runBlocking { store.discardOrderDraft(draftId) }
        override fun queueVisit(kind: String, clientVisitId: String?, checkInRequestId: String?, previousRequestId: String?,
            plannedVisitId: String?, outletId: String, intents: List<String>, unplannedReason: String?, note: String?,
            outcome: String?, reasonCode: String?, location: JSONObject?) = runBlocking {
            store.enqueue(VisitIntentFactory.create(scope, kind, clientVisitId, checkInRequestId, previousRequestId,
                plannedVisitId, outletId, intents, unplannedReason, note, outcome, reasonCode, location, at = 100), 100)
        }
    }

    @Test fun controllerSavesUpdatesAndDiscardsTheVisitDraft() = runBlocking {
        val store = ready()
        val controller = FieldController(Backend(store), this, Dispatchers.Unconfined, EmptyCoroutineContext, now = { 100L })
        controller.openDiagnostic(visit).join()
        controller.openOrder().join()
        controller.saveOrderDraft(listOf("product-1" to 2)).join()
        assertEquals(OrderDraftFailure.Code.CALL_NOT_OPEN.text, controller.diagnosticError)
        assertTrue(store.orderDrafts().isEmpty())

        controller.queueDiagnostic("visit.checkIn", null, null, null, null).join()
        var saved = 0
        controller.saveOrderDraft(listOf("product-1" to 2)) { saved++ }.join()
        assertNull(controller.diagnosticError); assertEquals(1, saved)
        val draft = controller.visitOrderDrafts.single()
        assertEquals(draft.draftId, controller.orderDraftId)
        assertEquals(draft, controller.openOrderDraft)
        controller.saveOrderDraft(listOf("product-1" to 5, "product-2" to 1)).join()
        assertEquals(1, store.orderDrafts().size)
        assertEquals(listOf(5, 1), controller.openOrderDraft!!.lines.map { it.quantity })
        assertEquals(1, store.history().size) // never enqueued

        // A different planned visit at the same outlet does not show this call's draft.
        controller.openDiagnostic(visit.copy(plannedVisitId = "planned-2")).join()
        assertTrue(controller.visitOrderDrafts.isEmpty())
        controller.openDiagnostic(visit).join()
        controller.openOrder(draft.draftId).join()
        controller.discardOrderDraft().join()
        assertFalse(controller.orderOpen)
        assertTrue(store.orderDrafts().isEmpty()); assertTrue(controller.visitOrderDrafts.isEmpty())
    }
}
