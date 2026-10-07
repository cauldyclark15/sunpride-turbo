package com.sunpride.van.printing

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.SaleReceipt
import com.sunpride.van.data.SaleReceiptLine
import java.time.ZonedDateTime
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ReceiptPrintingTest {
    @Test fun testReceiptContainsMetadataDisclaimerItemsAndQr() {
        val receipt = TestReceipts.build("H10P", "209", ZonedDateTime.parse("2026-10-06T12:34:56+08:00"))
        val text = receipt.elements.filterIsInstance<ReceiptElement.Text>().joinToString("\n") { it.text }
        assertTrue(text.contains("SUNPRIDE VAN SALES"))
        assertTrue(text.contains("TEST RECEIPT - NOT AN OFFICIAL RECEIPT"))
        assertTrue(text.contains("Device: H10P"))
        assertTrue(text.contains("2026-10-06 12:34:56 +08:00"))
        assertTrue(text.contains("Printer service: 209"))
        assertTrue(text.contains(TestReceipts.DISCLAIMER))
        assertEquals(TestReceipts.QR_TEST_DATA, receipt.elements.filterIsInstance<ReceiptElement.Qr>().single().data)
        assertEquals("P374.50", receipt.elements.filterIsInstance<ReceiptElement.Columns>().last().value)
        assertFalse(text.contains("₱"))
    }
    @Test fun usesExactAsciiMoneyIncludingNegativeAndLargeValues() {
        assertEquals("P0.00", PesoAmounts.fromCentavos(0))
        assertEquals("P-1.01", PesoAmounts.fromCentavos(-101))
        assertEquals("P92233720368547758.07", PesoAmounts.fromCentavos(Long.MAX_VALUE))
    }
    @Test fun fakeRecordsOnlyConnectedJobsAndReprintIsMarked() = runBlocking {
        val fake = FakeReceiptPrinter()
        val receipt = TestReceipts.build("test", "fake")
        assertEquals(PrintResult.Error(PrinterStatus.Disconnected), fake.print(receipt))
        val outcome = ReceiptPrinting(fake).saveThenPrint(save = { "saved-id" }, build = { receipt })
        assertEquals("saved-id", outcome.saved)
        assertEquals(PrintResult.Success, outcome.printing)
        assertEquals(PrintResult.Success, ReceiptPrinting(fake).reprint(receipt))
        assertFalse(fake.documents[0].isReprint)
        assertTrue(fake.documents[1].isReprint)
        assertTrue(fake.cut() is PrintResult.Unsupported)
        assertTrue(fake.openCashDrawer() is PrintResult.Unsupported)
        fake.close()
        assertEquals(PrinterStatus.Disconnected, fake.status())
    }
    @Test fun persistenceFailureNeverTouchesPrinter() = runBlocking {
        val fake = FakeReceiptPrinter()
        try {
            ReceiptPrinting(fake).saveThenPrint<String>(save = { error("disk full") }, build = { TestReceipts.build(it, "fake") })
            fail("Must propagate persistence failure")
        } catch (expected: IllegalStateException) { assertEquals("disk full", expected.message) }
        assertTrue(fake.documents.isEmpty())
        assertEquals(PrinterStatus.Disconnected, fake.status())
    }
    @Test fun unavailablePrinterKeepsSavedRecord() = runBlocking {
        val outcome = ReceiptPrinting(NoPrinter()).saveThenPrint(save = { 42 }, build = { TestReceipts.build("test", "none") })
        assertEquals(42, outcome.saved)
        assertEquals(PrintResult.Error(PrinterStatus.Unavailable), outcome.printing)
    }
    @Test fun saleReceiptPrintsPromotionFreeGoodsAndPriceSource() {
        val receipt = SaleReceipt("sale","R-1","Store",listOf(
            SaleReceiptLine(1,"p1","Pineapple Juice","PC","21",8_500,178_500,2,0,"PROMO-B10G1","PL-ROUTE-SALES","2")
        ),"PHP",178_500,178_500,0,1L,false,"cash","Cash",PaymentKind.CASH,"paid")
        val document = SaleReceiptDocuments.build(receipt,ReceiptHeader(null,null,null),
            PrintAttempt("print","sale",PrintKind.ORIGINAL,0,null,PrintOutcome.PRINTED,1),1L)
        val text = document.elements.filterIsInstance<ReceiptElement.Text>().joinToString("\n") { it.text }
        assertTrue(text.contains("Promo PROMO-B10G1  -P0.00"))
        assertTrue(text.contains("Free 2 PC (PROMO-B10G1)"))
        assertTrue(text.contains("Prices: PL-ROUTE-SALES"))
    }
}
