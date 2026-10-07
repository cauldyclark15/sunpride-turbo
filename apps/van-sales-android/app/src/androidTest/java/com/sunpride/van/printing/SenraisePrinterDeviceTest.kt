package com.sunpride.van.printing

import android.os.Build
import android.util.Log
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SenraisePrinterDeviceTest {
    @Test fun bindsRealServiceAndPrintsRealTestReceipt() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assumeTrue("Requires an attached Senraise printer", PrinterRegistry.hasSenraiseService(context))
        val printer = SenraiseEmbeddedPrinter(context)
        try {
            val state = printer.connect()
            assertTrue("Real printer did not connect: $state", state is PrinterStatus.Ready)
            val version = (state as PrinterStatus.Ready).serviceVersion
            assertTrue(version.isNotBlank())
            Log.i("SunpridePrinterTest", "REAL_PRINTER_SERVICE_VERSION=$version MODEL=${Build.MODEL}")
            Log.i("SunpridePrinterTest", "REAL_SCANNER_STATUS=${printer.scannerStatus()}")
            assertEquals(state, printer.status())
            val result = printer.print(TestReceipts.build(Build.MODEL, version, includePesoProbe = true))
            assertEquals("Real receipt job failed: $result", PrintResult.Success, result)
            // Vendor queues rendering on its Handler. Keep the service bound while paper feeds out.
            delay(5_000)
            assertTrue(printer.cut() is PrintResult.Unsupported)
            assertTrue(printer.openCashDrawer() is PrintResult.Unsupported)
            assertFalse(printer.capabilities.pesoGlyphVerified)
            Log.i("SunpridePrinterTest", "REAL_TEST_RECEIPT_PRINT_RESULT=Success; PESO_PROBE_SENT=P PHP ₱; GLYPH_VISUAL_CONFIRMATION_REQUIRED")
            println("REAL_PRINTER_SERVICE_VERSION=$version REAL_TEST_RECEIPT_PRINT_RESULT=Success")
        } finally { printer.close() }
    }

    /** VAN-017: the printer check and a REPRINT-marked sample sale receipt on the real H10P paper. */
    @Test fun diagnosesRealPrinterAndPrintsReprintMarkedSaleReceipt() = runBlocking {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        assumeTrue("Requires an attached Senraise printer", PrinterRegistry.hasSenraiseService(context))
        val printer = SenraiseEmbeddedPrinter(context)
        try {
            val check = printer.diagnostics()
            assertTrue("Real printer did not connect: ${check.status}", check.status is PrinterStatus.Ready)
            // The vendor ABI has no paper query: the check must say "not reported", never "OK".
            assertEquals(PaperState.NOT_REPORTED, check.paper)
            val receipt = com.sunpride.van.data.SaleReceipt("device-test-sale", "TRIP-20261007-V014-1-DEVICE00-0001", "Aling Nena Store (SAMPLE)",
                listOf(com.sunpride.van.data.SaleReceiptLine(1, "p1", "Pineapple Juice 1L", "PC", "2", 8_500, 17_000)),
                "PHP", 17_000, 20_000, 3_000, System.currentTimeMillis())
            val attempt = PrintAttempt("device-test", receipt.saleId, PrintKind.REPRINT, 1, "customer_copy", PrintOutcome.STARTED, System.currentTimeMillis())
            val doc = SaleReceiptDocuments.build(receipt, ReceiptHeader("Juan Dela Cruz (SAMPLE)", "TRIP-20261007-V014-1", "V014 NBC 1234"), attempt, System.currentTimeMillis())
            assertTrue(doc.isReprint)
            val result = printer.print(doc)
            assertEquals("Real reprint job failed: $result", PrintResult.Success, result)
            delay(5_000)
            Log.i("SunpridePrinterTest", "REAL_REPRINT_RECEIPT_PRINT_RESULT=Success; PAPER=${check.paper}; SCANNER_HINT=${check.scannerHint}")
        } finally { printer.close() }
        Unit
    }
}
