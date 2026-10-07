package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.pos.*
import com.sunpride.van.printing.*
import com.sunpride.van.sync.FakeVanBackend
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

/** VAN-017 receipt prints against real SQLCipher Room: scoped, recorded before printing, never touching the sale. */
@RunWith(AndroidJUnit4::class)
class ReceiptPrintStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private val key = "test-only-sqlcipher-key-not-a-production-secret".toByteArray()
    private val scope = StoreScope("https://test.invalid|full-subject","device-one")
    private lateinit var store: RoomVanStore
    private val at = 1791338400000L
    private val juice = "k57prod0000000000000000000000001"
    private val outlet = "k57out00000000000000000000000001"
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    @Before fun setup() {
        name = "van-receipt-print-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,key,name)
        store = RoomVanStore(db,scope,clock = { at+10 })
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }
    private fun fixture(serverTime: Long = at, tripId: String? = null): String {
        val o = JSONObject(FakeVanBackend.FIXTURE).put("serverTime",serverTime)
        o.getJSONObject("trip").put("status","active").put("routeSessionId","test-route")
        tripId?.let { o.getJSONObject("trip").put("tripId",it) }
        o.getJSONObject("load").put("status","posted")
        val lines = o.getJSONObject("load").getJSONArray("lines")
        for (i in 0 until lines.length()) lines.getJSONObject(i).put("actualBase",lines.getJSONObject(i).getString("expectedBase"))
        o.put("truckStock",JSONArray().put(JSONObject().put("productId",juice).put("availableBase","10").put("damagedBase","0")))
        return o.toString()
    }
    private fun saved() = runBlocking {
        store.replaceBootstrap(fixture())
        db.rows().insertPriceListLine(PriceListLineRow(s,d,"PL-TEST",juice,"PC",8_500,"PHP",at-1_000,null))
        store.commitSale(CheckoutRequest(UUID.randomUUID().toString(),outlet,listOf(CartLine(juice,3)),PaymentInput("cash",30_000)),25_500)
    }
    private suspend fun saleFacts() = listOf(db.rows().saleRows(s,d),db.rows().salelineRows(s,d),db.rows().paymentRows(s,d),
        db.rows().stockmovementRows(s,d),db.rows().outboxRows(s,d))

    @Test fun originalThenReasonedReprintsAreRecordedAndNeverChangeTheSale() = runBlocking {
        val receipt = saved()
        val before = saleFacts()
        val printer = FakeReceiptPrinter()
        val log = RoomReceiptPrintLog(db,scope,clock = { at+20 })
        val flow = ReceiptPrintFlow(printer,log) { at+30 }
        assertTrue(flow.print(receipt.saleId,explicit = false) is PrintJobResult.Printed)
        assertEquals(PrintJobResult.Refused(PrintRefusal.ALREADY_PRINTED),flow.print(receipt.saleId,explicit = false))
        assertEquals(PrintJobResult.Refused(PrintRefusal.REASON_REQUIRED),flow.print(receipt.saleId,explicit = true))
        repeat(ReprintRules.MAX_REPRINTS) { i ->
            val copy = flow.print(receipt.saleId,explicit = true,reasonCode = "customer_copy") as PrintJobResult.Printed
            assertEquals(i+1,copy.attempt.copyNumber)
        }
        assertEquals(PrintJobResult.Refused(PrintRefusal.LIMIT_REACHED),flow.print(receipt.saleId,true,"customer_copy"))
        assertEquals(listOf(false,true,true,true),printer.documents.map { it.isReprint })
        // A fresh log (app restart) reads the same history from the encrypted file.
        val rows = db.receiptPrints().forSale(s,d,receipt.saleId)
        assertEquals(listOf("original","reprint","reprint","reprint"),rows.map { it.kind })
        assertEquals(listOf(0,1,2,3),rows.map { it.copyNumber })
        assertEquals(listOf(null,"customer_copy","customer_copy","customer_copy"),rows.map { it.reason })
        assertTrue(rows.all { it.outcome == "printed" && it.finishedAt == at+20 })
        assertEquals(listOf(at+20,at+21,at+22,at+23),rows.map { it.startedAt })
        val list = RoomReceiptPrintLog(db,scope).savedSales().single()
        assertEquals(receipt.copy(replay = true),list.receipt)
        assertTrue(list.printed); assertEquals(0,list.reprintsLeft)
        // Printing wrote only print history: sale, lines, payment, stock and outbox bytes are unchanged.
        assertEquals(before,saleFacts())
    }

    @Test fun startedRowIsWrittenBeforeThePrinterAndAnUnfinishedPrintCountsAsPrinted() = runBlocking {
        val receipt = saved()
        val log = RoomReceiptPrintLog(db,scope)
        val go = log.begin(receipt.saleId,explicit = false,reasonCode = null) as BeginPrint.Go
        assertEquals(PrintKind.ORIGINAL,go.attempt.kind)
        assertEquals(listOf("started"),db.receiptPrints().forSale(s,d,receipt.saleId).map { it.outcome })
        // App died before finish: the next automatic print must not produce a second "original".
        assertEquals(BeginPrint.Refused(PrintRefusal.ALREADY_PRINTED),RoomReceiptPrintLog(db,scope).begin(receipt.saleId,false,null))
        val next = RoomReceiptPrintLog(db,scope).begin(receipt.saleId,true,"unreadable") as BeginPrint.Go
        assertEquals(PrintKind.REPRINT,next.attempt.kind); assertEquals(1,next.attempt.copyNumber)
        assertEquals("Aling Nena Store",next.receipt.customerName); assertEquals("TRIP-20261007-V014-1",next.header.tripNumber)
        log.finish(go.attempt.printId,PrintOutcome.MAYBE_PRINTED)
        assertThrows(IllegalStateException::class.java) { runBlocking { log.finish(go.attempt.printId,PrintOutcome.PRINTED) } }
        assertEquals("maybe_printed",db.receiptPrints().forSale(s,d,receipt.saleId).first().outcome)
    }

    @Test fun failedBeforePaperKeepsTheOriginalAvailable() = runBlocking {
        val receipt = saved()
        val printer = FakeReceiptPrinter().apply { nextFailure = PrintResult.Error(PrinterStatus.Disconnected,mayHavePrinted = false) }
        val flow = ReceiptPrintFlow(printer,RoomReceiptPrintLog(db,scope))
        assertTrue(flow.print(receipt.saleId,false) is PrintJobResult.Failed)
        val retry = flow.print(receipt.saleId,true) as PrintJobResult.Printed
        assertEquals(PrintKind.ORIGINAL,retry.attempt.kind)
        assertEquals(listOf("not_printed","printed"),db.receiptPrints().forSale(s,d,receipt.saleId).map { it.outcome })
        // Paper reported out: refused before anything is recorded.
        printer.paper = PaperState.OUT
        assertEquals(PrintJobResult.Refused(PrintRefusal.PAPER_OUT),flow.print(receipt.saleId,true,"customer_copy"))
        assertEquals(2,db.receiptPrints().forSale(s,d,receipt.saleId).size)
    }

    /** Same trip, newer bootstrap: product renamed and re-unit (PC → CS of 1000), customer and seller renamed. */
    private fun renamedFixture(): String {
        val o = JSONObject(fixture(serverTime = at+50))
        o.getJSONObject("seller").put("name","Someone Else")
        val p = o.getJSONArray("products").getJSONObject(0)
        p.put("name","Renamed Juice").put("uomCode","CS").put("quantityScale","1000")
        o.getJSONArray("customers").getJSONObject(0).put("name","Renamed Store")
        return o.toString()
    }
    /** Same trip, newer bootstrap: the sold product and the customer are no longer on the phone. */
    private fun removedFixture(): String {
        val o = JSONObject(fixture(serverTime = at+60))
        val products = o.getJSONArray("products"); products.remove(0)
        val customers = o.getJSONArray("customers"); customers.remove(0)
        return o.toString()
    }
    /** The text lines that reach paper. */
    private fun paper(doc: ReceiptDocument) = ReceiptLayoutFormatter().format(doc).filterIsInstance<ReceiptCommand.Line>().joinToString("\n") { it.text }

    @Test fun reprintKeepsTheSaleTimeFactsAfterMasterDataIsRenamedOrRemoved() = runBlocking {
        val receipt = saved()
        val printer = FakeReceiptPrinter()
        val flow = ReceiptPrintFlow(printer,RoomReceiptPrintLog(db,scope)) { at+30 }
        assertTrue(flow.print(receipt.saleId,explicit = false) is PrintJobResult.Printed)
        val original = paper(printer.documents.single())
        listOf("Aling Nena Store","Pineapple Juice 1L","3 PC","Juan Dela Cruz","TRIP-20261007-V014-1","V014 NBC 1234").forEach {
            assertTrue("original shows $it",original.contains(it)) }
        for (bootstrap in listOf(renamedFixture(),removedFixture())) {
            store.replaceBootstrap(bootstrap)
            val go = RoomReceiptPrintLog(db,scope).begin(receipt.saleId,true,"customer_copy") as BeginPrint.Go
            // Exactly what Complete sale returned, and the same seller/trip/truck as the original slip.
            assertEquals(receipt.copy(replay = true),go.receipt)
            assertEquals(ReceiptHeader("Juan Dela Cruz","TRIP-20261007-V014-1","V014 NBC 1234"),go.header)
            assertEquals(receipt.copy(replay = true),RoomReceiptPrintLog(db,scope).savedSales().single().receipt)
        }
        val copy = flow.print(receipt.saleId,explicit = true,reasonCode = "customer_copy") as PrintJobResult.Printed
        val reprint = paper(printer.documents.last())
        assertTrue(copy.attempt.kind == PrintKind.REPRINT && printer.documents.last().isReprint)
        listOf("Aling Nena Store","Pineapple Juice 1L","3 PC","Juan Dela Cruz","REPRINT").forEach { assertTrue("reprint shows $it",reprint.contains(it)) }
        listOf("Renamed","0.003","CS","Someone Else",juice).forEach { assertFalse("reprint must not show $it",reprint.contains(it)) }
        // Replaying Complete sale with the same cart also returns the frozen receipt, not a rebuild.
        assertEquals(receipt.copy(replay = true),store.commitSale(CheckoutRequest(receipt.saleId,outlet,listOf(CartLine(juice,3)),PaymentInput("cash",30_000)),25_500))
    }

    @Test fun theFrozenReceiptIsWrittenWithTheSaleAndNeverChanges() = runBlocking {
        val receipt = saved()
        val row = checkNotNull(db.receiptPrints().saleReceipt(s,d,receipt.saleId))
        assertEquals(receipt.copy(replay = true) to ReceiptHeader("Juan Dela Cruz","TRIP-20261007-V014-1","V014 NBC 1234"),FrozenReceipts.decode(row.documentJson))
        assertThrows(Exception::class.java) { runBlocking { db.receiptPrints().insertSaleReceipt(row.copy(documentJson = "{}")) } }
        store.replaceBootstrap(renamedFixture())
        assertEquals(row,db.receiptPrints().saleReceipt(s,d,receipt.saleId))
    }

    @Test fun onlyTheSignedInSellersSalesOnTheCurrentTripPrint() = runBlocking {
        val receipt = saved()
        // Another account or device on the same phone cannot see or print this sale.
        val other = RoomReceiptPrintLog(db,StoreScope("https://test.invalid|someone-else",d))
        assertEquals(BeginPrint.Refused(PrintRefusal.SALE_NOT_FOUND),other.begin(receipt.saleId,false,null))
        assertTrue(other.savedSales().isEmpty())
        // A newer bootstrap moves the phone to another trip: old receipts come from the office.
        store.replaceBootstrap(fixture(serverTime = at+50,tripId = "k57trip0000000000000000000000002"))
        assertEquals(BeginPrint.Refused(PrintRefusal.NOT_THIS_TRIP),RoomReceiptPrintLog(db,scope).begin(receipt.saleId,false,null))
        assertTrue(RoomReceiptPrintLog(db,scope).savedSales().isEmpty())
        // Held (signed out / other account signed in): nothing prints.
        store.hold()
        assertEquals(BeginPrint.Refused(PrintRefusal.HELD),RoomReceiptPrintLog(db,scope).begin(receipt.saleId,true,"customer_copy"))
        assertTrue(db.receiptPrints().all(s,d).isEmpty())
    }
}
