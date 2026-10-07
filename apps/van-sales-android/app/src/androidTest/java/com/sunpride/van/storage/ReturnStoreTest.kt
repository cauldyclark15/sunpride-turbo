package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.pos.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

/** VAN-019 customer returns against real SQLCipher Room: validated, saved atomically, truck stock moved only per disposition. */
@RunWith(AndroidJUnit4::class)
class ReturnStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private val key = "test-only-sqlcipher-key-not-a-production-secret".toByteArray()
    private val scope = StoreScope("https://test.invalid|full-subject","device-one")
    private lateinit var store: RoomVanStore
    private lateinit var returns: ReturnStore
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val chunks = "k57prod0000000000000000000000002"
    private val outlet = "k57out00000000000000000000000001"
    private val otherOutlet = "k57out00000000000000000000000002"
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    @Before fun setup() {
        name = "van-return-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,key,name)
        store = RoomVanStore(db,scope,clock = { at+10 })
        returns = ReturnStore(store)
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }
    private fun fixture(active: Boolean = true, serverTime: Long = at): String {
        val o = JSONObject(FakeVanBackend.FIXTURE).put("serverTime",serverTime)
        if (active) {
            o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
            o.getJSONObject("load").put("status","posted")
            val lines = o.getJSONObject("load").getJSONArray("lines")
            for (i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        }
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase","10").put("damagedBase","0"))
            .put(JSONObject().put("productId",chunks).put("availableBase","5").put("damagedBase","0")))
        return o.toString()
    }
    // Prices come only through the bootstrap feed (SP-0129 fixture: juice ₱68.50 per PC). A second, disagreeing price
    // line for the same product makes the price ambiguous, and checkout rightly refuses it as UNPRICED.
    private val juicePriceMinor = 6_850L
    private fun ready(active: Boolean = true) = runBlocking { store.replaceBootstrap(fixture(active)) }
    private suspend fun sell(qty: Long = 6): String {
        val id = UUID.randomUUID().toString()
        store.commitSale(CheckoutRequest(id,outlet,listOf(CartLine(juice,qty)),PaymentInput("cash",1_000_000)),juicePriceMinor*qty)
        return id
    }
    private fun line(product: String = juice, qty: Long = 2, reason: String = "damaged", disposition: ReturnDisposition = ReturnDisposition.BAD_STOCK,
        uom: String = "PC", lot: String? = null, expiry: String? = null) = ReturnLineInput(product,uom,qty,reason,disposition,lot,expiry)
    private fun request(vararg lines: ReturnLineInput, saleId: String? = null, customer: String = outlet, id: String = UUID.randomUUID().toString()) =
        ReturnRequest(id,customer,saleId,lines.toList(),"Picked up at the store")
    private suspend fun available(p: String = juice) = store.stock().single { it.productId == p }.availableBase
    private suspend fun damaged(p: String = juice) = store.stock().single { it.productId == p }.damagedBase
    private fun refused(block: suspend () -> Unit): Set<ReturnProblem> = runBlocking {
        val failure = runCatching { block() }.exceptionOrNull()
        assertTrue("expected ReturnRefused, got $failure",failure is ReturnRefused)
        (failure as ReturnRefused).issues.map { it.problem }.toSet()
    }

    @Test fun returnIsSavedAtomicallyAndMovesStockOnlyPerDisposition() = runBlocking {
        ready()
        val saleId = sell(6)
        assertEquals(4L,available())
        val receipt = returns.commit(request(
            line(qty = 2,reason = "wrong_item",disposition = ReturnDisposition.RESELLABLE),
            line(qty = 1,reason = "expired",lot = "lot-26a",expiry = "2026-09-30"),
            line(qty = 1,reason = "spoiled",disposition = ReturnDisposition.DISPOSED_AT_OUTLET,lot = "LOT-26B"),
            saleId = saleId))
        // Sale was 0001; the return takes the next number in the same receipt sequence.
        assertTrue(receipt.returnNumber.endsWith("-0002"))
        assertEquals(listOf(ReturnApprovalReason.DISPOSED_AT_OUTLET),receipt.approvalReasons)
        assertEquals(ReturnRules.STATUS_AWAITING_APPROVAL,receipt.status)
        // Good stock from this receipt is sellable again; expired goes to damaged; thrown-away goods move nothing.
        assertEquals(listOf(ReturnStockEffect.AVAILABLE,ReturnStockEffect.DAMAGED,ReturnStockEffect.NONE),receipt.lines.map { it.stockEffect })
        assertEquals(listOf(false,false,true),receipt.lines.map { it.approvalRequired })
        assertEquals(6L,available()); assertEquals(1L,damaged())
        val header = db.rows().customerreturnRows(s,d).single()
        assertEquals(outlet,header.customerId); assertEquals(receipt.returnNumber,header.receiptNumber); assertEquals(ReturnRules.STATUS_AWAITING_APPROVAL,header.status)
        assertEquals(listOf("available","damaged","none"),db.rows().returnlineRows(s,d).sortedBy { it.lineNumber }.map { it.stockStatus })
        assertEquals(listOf("wrong_item","expired","spoiled"),db.rows().returnlineRows(s,d).sortedBy { it.lineNumber }.map { it.reason })
        val movements = db.rows().stockmovementRows(s,d).filter { it.type == "RETURN" }
        assertEquals(setOf("available" to 2L,"damaged" to 1L),movements.map { it.stockStatus to it.quantityBase }.toSet())
        assertTrue(movements.all { it.clientRequestId == header.idempotencyKey && it.reason == ReturnStore.MOVEMENT_REASON })
        val op = db.rows().outboxRows(s,d).single { it.kind == RETURN_KIND }
        assertEquals(SALE_PARKED,op.status); assertEquals(header.idempotencyKey,op.clientRequestId)
        val p = JSONObject(op.operationJson).getJSONObject("payload")
        assertEquals(saleId,p.getJSONObject("originalSale").getString("saleId"))
        assertEquals("Picked up at the store",p.getString("note"))
        val l2 = p.getJSONArray("lines").getJSONObject(1)
        assertEquals("LOT-26A",l2.getString("lotNumber")); assertEquals("2026-09-30",l2.getString("expiryDate"))
        assertEquals("PC",l2.getString("uomCode")); assertEquals("bad_stock",l2.getString("disposition")); assertEquals("1",l2.getString("quantityBase"))
        assertEquals(listOf("disposed_at_outlet"),p.getJSONObject("approval").getJSONArray("reasons").let { a -> (0 until a.length()).map { a.getString(it) } })
        // Parked, never sent; counted apart from sales; a newer snapshot keeps the return applied.
        assertTrue(store.pending().isEmpty())
        val status = store.syncStatus.first(); assertEquals(1,status.savedReturns); assertEquals(1,status.savedSales)
        store.replaceBootstrap(fixture(serverTime = at+50))
        assertEquals(6L,available()); assertEquals(1L,damaged()); Unit
    }
    @Test fun goodStockFromAReceiptGoesBackToSellableStockWithoutApproval() = runBlocking {
        ready()
        val saleId = sell(6)
        val receipt = returns.commit(request(line(qty = 2,reason = "wrong_item",disposition = ReturnDisposition.RESELLABLE),saleId = saleId))
        assertTrue(receipt.approvalReasons.isEmpty()); assertEquals(ReturnRules.STATUS_RECORDED,receipt.status)
        assertEquals(6L,available()); assertEquals(0L,damaged())
        // The rest of the receipt can be returned; one more than sold cannot (earlier returns count).
        assertEquals(setOf(ReturnProblem.MORE_THAN_SOLD),refused { returns.commit(request(line(qty = 5),saleId = saleId)) })
        returns.commit(request(line(qty = 4),saleId = saleId))
        assertEquals(mapOf(juice to 6L),returns.returnedBase()[saleId]); Unit
    }
    @Test fun casesAreRecordedInTheirUnitAndBaseQuantity() = runBlocking {
        ready()
        val receipt = returns.commit(request(line(uom = "CS",qty = 48,reason = "overstock",disposition = ReturnDisposition.BAD_STOCK)))
        assertEquals("2",receipt.lines.single().unitQuantity); assertEquals(48L,damaged())
        assertEquals(listOf(ReturnApprovalReason.NOT_LINKED_TO_SALE),receipt.approvalReasons)
        val l = JSONObject(db.rows().outboxRows(s,d).single().operationJson).getJSONObject("payload").getJSONArray("lines").getJSONObject(0)
        assertEquals("CS",l.getString("uomCode")); assertEquals("2",l.getString("uomQuantity")); assertEquals("48",l.getString("quantityBase")); Unit
    }
    @Test fun savingTheSameReturnTwiceRecordsItOnce() = runBlocking {
        ready()
        val r = request(line())
        val first = returns.commit(r)
        val again = returns.commit(r)
        assertTrue(again.replay); assertEquals(first.returnNumber,again.returnNumber)
        assertEquals(first.lines.map { it.stockEffect },again.lines.map { it.stockEffect }); assertEquals(first.approvalReasons,again.approvalReasons)
        assertEquals(1,db.rows().customerreturnRows(s,d).size); assertEquals(2L,damaged())
        assertTrue(runCatching { returns.commit(r.copy(lines = listOf(line(qty = 3)))) }.isFailure)
        assertEquals(2L,damaged()); Unit
    }
    @Test fun replayKeepsTheSavedUnitAndProductAfterTheOfficeChangesThem() = runBlocking {
        ready()
        val r = request(line(uom = "CS",qty = 48,reason = "overstock",disposition = ReturnDisposition.BAD_STOCK),
            line(product = chunks,qty = 1,reason = "overstock",disposition = ReturnDisposition.BAD_STOCK))
        val first = returns.commit(r)
        // Same trip, new bootstrap: the juice case is now 12 PC and renamed; the chunks are no longer sold.
        val o = JSONObject(fixture())
        val products = o.getJSONArray("products")
        val juiceJson = products.getJSONObject(0).put("name","Pineapple Juice 1L (new pack)")
        juiceJson.getJSONArray("barcodeUnits").getJSONObject(1).put("baseQuantity","12")
        products.remove(1)
        // A bootstrap never prices a product it does not carry (the codec refuses it), so the chunks price goes too.
        val prices = o.getJSONArray("priceLines")
        (prices.length() - 1 downTo 0).filter { prices.getJSONObject(it).getString("productId") == chunks }.forEach { prices.remove(it) }
        o.getJSONObject("load").getJSONArray("lines").remove(1)
        o.getJSONArray("truckStock").remove(1)
        store.replaceBootstrap(o.toString())
        val again = returns.commit(r)
        assertTrue(again.replay); assertEquals(first.returnNumber,again.returnNumber)
        assertEquals(listOf("2","1"),again.lines.map { it.unitQuantity })
        assertEquals(listOf(24L,1L),again.lines.map { it.unit.baseQuantity })
        assertEquals(listOf("Pineapple Juice 1L","Pineapple Chunks 432g"),again.lines.map { it.product.name })
        assertEquals(first.customerName,again.customerName)
        assertEquals(1,db.rows().customerreturnRows(s,d).size); Unit
    }
    @Test fun sameReturnIdWithAnyChangedDetailIsAConflict() = runBlocking {
        ready()
        val saleId = sell()
        val base = ReturnLineInput(juice,"PC",2,"overstock",ReturnDisposition.BAD_STOCK,null,null)
        val r = request(base,saleId = saleId)
        returns.commit(r)
        val variants = mapOf(
            "disposition" to r.copy(lines = listOf(base.copy(disposition = ReturnDisposition.RESELLABLE))),
            "reason" to r.copy(lines = listOf(base.copy(reasonCode = "quality_complaint",lotNumber = "LOT-1"))),
            "unit" to r.copy(lines = listOf(base.copy(uomCode = "CS",quantityBase = 24))),
            "batch" to r.copy(lines = listOf(base.copy(lotNumber = "LOT-1"))),
            "expiry" to r.copy(lines = listOf(base.copy(expiryDate = "2027-01-31"))),
            "sale link" to r.copy(originalSaleId = null),
            "note" to r.copy(note = "Different note"),
        )
        variants.forEach { (field,variant) ->
            val failure = runCatching { returns.commit(variant) }.exceptionOrNull()
            assertTrue("$field change must be a conflict, got $failure",failure is ReturnReplayConflict)
        }
        // The same capture written with extra spaces is still the same return.
        assertTrue(returns.commit(r.copy(note = "  Picked up at the store ")).replay)
        assertEquals(1,db.rows().customerreturnRows(s,d).size); assertEquals(2L,damaged()); Unit
    }
    @Test fun refusedOrFailedReturnWritesNothing() = runBlocking {
        ready()
        assertEquals(setOf(ReturnProblem.BATCH_MISSING),refused { returns.commit(request(line(reason = "expired"))) })
        assertEquals(setOf(ReturnProblem.DISPOSITION_NOT_ALLOWED),refused { returns.commit(request(line(reason = "expired",lot = "L1",disposition = ReturnDisposition.RESELLABLE))) })
        val saleId = sell(2)
        assertEquals(setOf(ReturnProblem.SALE_OTHER_CUSTOMER),refused { returns.commit(request(line(),saleId = saleId,customer = otherOutlet)) })
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_return BEFORE INSERT ON outbox WHEN NEW.kind='return.record' BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching { returns.commit(request(line())) }.isFailure)
        assertTrue(db.rows().customerreturnRows(s,d).isEmpty()); assertTrue(db.rows().returnlineRows(s,d).isEmpty())
        assertTrue(db.rows().stockmovementRows(s,d).none { it.type == "RETURN" }); assertEquals(0L,damaged())
        assertEquals(1,db.rows().transactionidRows(s,d).size)
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_return")
        assertTrue("the rolled-back return did not burn a number",returns.commit(request(line())).returnNumber.endsWith("-0002")); Unit
    }
    @Test fun tripNotOnRouteOrHeldPhoneRefuses() {
        ready(active = false)
        assertEquals(setOf(ReturnProblem.TRIP_NOT_OPEN),refused { returns.commit(request(line())) })
        runBlocking { store.replaceBootstrap(fixture(serverTime = at+1)); store.hold() }
        assertEquals(setOf(ReturnProblem.TRIP_NOT_OPEN),refused { returns.commit(request(line())) })
    }
    @Test fun walkInReturnKeepsTheLocalCustomerAndNeedsApproval() = runBlocking {
        ready()
        val walkIn = store.addWalkInCustomer("Corner Store","Not on the route list")
        val receipt = returns.commit(request(line(),customer = walkIn.outletId))
        assertEquals("Corner Store",receipt.customerName)
        assertTrue(ReturnApprovalReason.WALK_IN in receipt.approvalReasons)
        val c = JSONObject(db.rows().outboxRows(s,d).single().operationJson).getJSONObject("payload").getJSONObject("customer")
        assertEquals("Corner Store",c.getJSONObject("walkIn").getString("name")); assertFalse(c.has("outletId")); Unit
    }
}
