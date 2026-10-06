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

/** VAN-011 checkout against real SQLCipher Room: validated, saved atomically on the phone, never sent before a gateway exists. */
@RunWith(AndroidJUnit4::class)
class SaleCheckoutStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private val key = "test-only-sqlcipher-key-not-a-production-secret".toByteArray()
    private val scope = StoreScope("https://test.invalid|full-subject","device-one")
    private lateinit var store: RoomVanStore
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val chunks = "k57prod0000000000000000000000002"
    private val outlet = "k57out00000000000000000000000001"
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    @Before fun setup() {
        name = "van-checkout-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,key,name)
        store = RoomVanStore(db,scope,clock = { at+10 })
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }
    private fun fixture(active: Boolean = true, available: Long = 10, serverTime: Long = at): String {
        val o = JSONObject(FakeVanBackend.FIXTURE).put("serverTime",serverTime)
        if (active) {
            o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
            o.getJSONObject("load").put("status","posted")
            val lines = o.getJSONObject("load").getJSONArray("lines")
            for (i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        }
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase",available.toString()).put("damagedBase","0"))
            .put(JSONObject().put("productId",chunks).put("availableBase","5").put("damagedBase","0")))
        return o.toString()
    }
    private fun ready(active: Boolean = true) = runBlocking {
        store.replaceBootstrap(fixture(active))
        // Test-only governed price: ₱85.00 per PC for the juice; the chunks stay unpriced ("Priced by the office").
        db.rows().insertPriceListLine(PriceListLineRow(s,d,"PL-TEST",juice,"PC",8_500,"PHP",at-1_000,null))
    }
    private fun sale(qty: Long = 3, customer: String = outlet, cash: Long = 30_000, id: String = UUID.randomUUID().toString(), product: String = juice) =
        CheckoutRequest(id,customer,listOf(CartLine(product,qty)),PaymentInput(PaymentTerms.CASH,cash))
    private suspend fun nothingWritten() {
        assertTrue(db.rows().saleRows(s,d).isEmpty()); assertTrue(db.rows().salelineRows(s,d).isEmpty())
        assertTrue(db.rows().paymentRows(s,d).isEmpty()); assertTrue(db.rows().stockmovementRows(s,d).isEmpty())
        assertTrue(db.rows().outboxRows(s,d).isEmpty()); assertTrue(db.rows().transactionidRows(s,d).isEmpty())
        assertTrue(db.rows().sequencecounterRows(s,d).isEmpty())
        assertEquals(10L,store.stock().single { it.productId == juice }.availableBase)
    }
    private fun refused(block: suspend () -> Unit): Set<CheckoutProblem> = runBlocking {
        val failure = runCatching { block() }.exceptionOrNull()
        assertTrue("expected CheckoutRefused, got $failure",failure is CheckoutRefused)
        (failure as CheckoutRefused).issues.map { it.problem }.toSet()
    }

    @Test fun saleIsSavedAtomicallyOnThePhoneBeforeAnySync() = runBlocking {
        ready()
        val receipt = store.commitSale(sale(),25_500)
        assertEquals("TRIP-20261007-V014-1-${com.sunpride.van.ids.TransactionIds.deviceTag(d)}-0001",receipt.receiptNumber)
        assertEquals(25_500L,receipt.totalMinor); assertEquals(4_500L,receipt.changeMinor); assertEquals("Aling Nena Store",receipt.customerName)
        val row = db.rows().saleRows(s,d).single()
        assertEquals("saved",row.status); assertEquals(outlet,row.customerId); assertEquals(25_500L,row.totalMinor)
        assertEquals(listOf(Triple(juice,3L,25_500L)),db.rows().salelineRows(s,d).map { Triple(it.productId,it.quantityBase,it.totalMinor) })
        assertEquals(listOf("cash" to 25_500L),db.rows().paymentRows(s,d).map { it.method to it.amountMinor })
        val movement = db.rows().stockmovementRows(s,d).single()
        assertEquals("SALE",movement.type); assertEquals(-3L,movement.quantityBase); assertEquals(row.idempotencyKey,movement.clientRequestId)
        assertEquals(7L,store.stock().single { it.productId == juice }.availableBase)
        val op = db.rows().outboxRows(s,d).single()
        assertEquals(SALE_KIND,op.kind); assertEquals(SALE_PARKED,op.status); assertEquals(row.idempotencyKey,op.clientRequestId)
        val payload = JSONObject(op.operationJson).getJSONObject("payload")
        assertEquals(receipt.receiptNumber,payload.getString("receiptNumber")); assertEquals("25500",payload.getString("totalMinor"))
        assertEquals("PL-TEST",payload.getJSONArray("lines").getJSONObject(0).getJSONArray("priceListIds").getString(0))
        assertEquals("30000",payload.getJSONObject("payment").getString("tenderedMinor"))
        // Saved, not uploaded: the sync engine never picks a parked sale, and status counts it separately.
        assertTrue(store.pending().isEmpty())
        val status = store.syncStatus.first(); assertEquals(1,status.savedSales); assertEquals(0,status.queued)
        // A newer office snapshot that does not know the sale keeps it deducted.
        store.replaceBootstrap(fixture(serverTime = at+50))
        assertEquals(7L,store.stock().single { it.productId == juice }.availableBase); Unit
    }
    @Test fun completingTheSameSaleTwiceDoesNotSellTwice() = runBlocking {
        ready()
        val request = sale()
        val first = store.commitSale(request,25_500)
        val again = store.commitSale(request,25_500)
        assertTrue(again.replay); assertEquals(first.receiptNumber,again.receiptNumber); assertEquals(first.changeMinor,again.changeMinor)
        assertEquals(1,db.rows().saleRows(s,d).size); assertEquals(1,db.rows().transactionidRows(s,d).size)
        assertEquals(7L,store.stock().single { it.productId == juice }.availableBase)
        assertTrue(runCatching { store.commitSale(request.copy(lines = listOf(CartLine(juice,4))),34_000) }.isFailure)
        assertEquals(2L,store.commitSale(sale(qty = 1,cash = 8_500),8_500).receiptNumber.takeLast(4).toLong()); Unit
    }
    @Test fun refusedCheckoutWritesNothing() {
        ready()
        assertEquals(setOf(CheckoutProblem.INSUFFICIENT_STOCK),refused { store.commitSale(sale(qty = 11,cash = 100_000),93_500) })
        assertEquals(setOf(CheckoutProblem.UNPRICED),refused { store.commitSale(sale(product = chunks,qty = 1),0) })
        assertEquals(setOf(CheckoutProblem.CASH_SHORT),refused { store.commitSale(sale(cash = 25_499),25_500) })
        assertEquals(setOf(CheckoutProblem.UNKNOWN_CUSTOMER),refused { store.commitSale(sale(customer = "k57out-unknown"),25_500) })
        assertEquals(setOf(CheckoutProblem.CREDIT_TERMS_UNAVAILABLE),refused { store.commitSale(sale().copy(payment = PaymentInput(PaymentTerms.CREDIT,null)),25_500) })
        // The seller agreed ₱255.00; a price that changed underneath refuses instead of charging something else.
        assertEquals(setOf(CheckoutProblem.PRICES_CHANGED),refused { store.commitSale(sale(),25_000) })
        runBlocking { nothingWritten() }
    }
    @Test fun failureMidTransactionRollsBackReceiptNumberStockAndSale() = runBlocking {
        ready()
        db.openHelper.writableDatabase.execSQL("CREATE TRIGGER fail_sale BEFORE INSERT ON outbox WHEN NEW.kind='sale.record' BEGIN SELECT RAISE(ABORT,'injected'); END")
        assertTrue(runCatching { store.commitSale(sale(),25_500) }.isFailure)
        nothingWritten()
        db.openHelper.writableDatabase.execSQL("DROP TRIGGER fail_sale")
        assertTrue("the rolled-back sale did not burn a receipt number",store.commitSale(sale(),25_500).receiptNumber.endsWith("-0001")); Unit
    }
    @Test fun notSellingTripOrHeldPhoneRefuses() {
        ready(active = false)
        assertEquals(setOf(CheckoutProblem.TRIP_NOT_SELLING),refused { store.commitSale(sale(),25_500) })
        runBlocking { store.replaceBootstrap(fixture(serverTime = at+1)); store.hold() }
        assertEquals(setOf(CheckoutProblem.TRIP_NOT_SELLING),refused { store.commitSale(sale(),25_500) })
        runBlocking { nothingWritten() }
    }
    @Test fun walkInSaleKeepsTheLocalCustomerInTheSavedOperation() = runBlocking {
        ready()
        val walkIn = store.addWalkInCustomer("Corner Store","Not on the route list")
        val receipt = store.commitSale(sale(customer = walkIn.outletId,qty = 2,cash = 17_000),17_000)
        assertEquals("Corner Store",receipt.customerName); assertEquals(0L,receipt.changeMinor)
        val customer = JSONObject(db.rows().outboxRows(s,d).single().operationJson).getJSONObject("payload").getJSONObject("customer")
        assertFalse("a local walk-in is never sent as an outlet ID",customer.has("outletId"))
        assertEquals("Corner Store",customer.getJSONObject("walkIn").getString("name")); Unit
    }
}
