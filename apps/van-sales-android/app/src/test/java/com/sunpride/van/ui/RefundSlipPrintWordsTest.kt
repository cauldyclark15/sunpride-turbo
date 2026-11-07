package com.sunpride.van.ui

import com.sunpride.van.printing.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** b33: a refund slip connects the printer first (the Senraise reported "Could not print" on a fresh app start) and never claims paper. */
class RefundSlipPrintWordsTest {
    private val doc = ReceiptDocument(listOf(ReceiptElement.Text("CREDIT MEMO")), false)

    @Test fun aPrinterNeverConnectedInThisSessionStillPrints() = runBlocking {
        val printer = FakeReceiptPrinter()
        assertTrue("a bare print() on an unconnected printer is the b32 failure", printer.print(doc) is PrintResult.Error)
        val fresh = FakeReceiptPrinter()
        val words = printRefundSlipWords(fresh, doc)
        assertEquals(1, fresh.documents.size)
        assertTrue(words, words.startsWith("Slip sent to the printer."))
        assertFalse(words.lowercase().contains("paper loaded"))
    }
    @Test fun outOfPaperAndNoPrinterAreSaidPlainly() = runBlocking {
        assertTrue(printRefundSlipWords(FakeReceiptPrinter(PaperState.OUT), doc).contains("out of paper"))
        assertTrue(printRefundSlipWords(NoPrinter(), doc).contains("no printer on this phone"))
    }
}
