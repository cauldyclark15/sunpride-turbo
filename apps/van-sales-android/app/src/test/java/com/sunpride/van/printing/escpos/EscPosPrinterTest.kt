package com.sunpride.van.printing.escpos

import com.sunpride.van.data.SaleReceipt
import com.sunpride.van.data.SaleReceiptLine
import com.sunpride.van.printing.BeginPrint
import com.sunpride.van.printing.PaperState
import com.sunpride.van.printing.PrintAttempt
import com.sunpride.van.printing.PrintJobResult
import com.sunpride.van.printing.PrintKind
import com.sunpride.van.printing.PrintOutcome
import com.sunpride.van.printing.ReceiptHeader
import com.sunpride.van.printing.ReceiptPrintLog
import com.sunpride.van.printing.PrintResult
import com.sunpride.van.printing.PrinterSetupProblem
import com.sunpride.van.printing.PrinterStatus
import com.sunpride.van.printing.ReceiptDocument
import com.sunpride.van.printing.ReceiptElement
import com.sunpride.van.printing.ReceiptPrintFlow
import com.sunpride.van.printing.TestReceipts
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Scripted printer link: what happens on open, what the paper sensor answers, when writes break. */
class FakeLink(
    private val openFails: Boolean = false,
    private val openBlocks: Boolean = false,
    var reply: Int? = 0x12,
    /** Throw on the n-th write (1-based), counting the status request too. */
    var failOnWrite: Int? = null,
) : EscPosTransport {
    val written = ByteArrayOutputStream()
    var writes = 0
    var closed = false
    private val released = CountDownLatch(1)
    override fun open() {
        if (openBlocks) { released.await(5, TimeUnit.SECONDS); throw IOException("aborted") }
        if (openFails) throw IOException("refused")
    }
    override fun write(bytes: ByteArray) {
        if (closed) throw IOException("closed")
        writes++
        if (failOnWrite == writes) throw IOException("broken pipe")
        written.write(bytes)
    }
    override fun flush() { if (closed) throw IOException("closed") }
    override fun readByte(timeoutMillis: Long): Int? = reply
    override fun drainInput() { if (closed) throw IOException("closed") }
    override fun close() { closed = true; released.countDown() }
    fun receiptBytes(): ByteArray = written.toByteArray().let { all ->
        // Strip status requests (DLE EOT 4) to see only the receipt.
        val out = ByteArrayOutputStream(); var i = 0
        while (i < all.size) {
            if (i + 2 < all.size && all[i] == 0x10.toByte() && all[i + 1] == 0x04.toByte() && all[i + 2] == 0x04.toByte()) i += 3
            else out.write(all[i++].toInt())
        }
        out.toByteArray()
    }
}

class EscPosPrinterTest {
    private val receipt = TestReceipts.build("MPT-II", "ESC/POS")

    private fun printer(vararg links: FakeLink, problem: () -> PrinterSetupProblem? = { null }, attempts: Int = 3): Pair<EscPosPrinter, MutableList<FakeLink>> {
        val queue = ArrayDeque(links.toList())
        val used = mutableListOf<FakeLink>()
        val printer = EscPosPrinter(
            "MPT-II",
            transports = { (queue.removeFirstOrNull() ?: FakeLink(openFails = true)).also(used::add) },
            setupProblem = problem,
            connectAttempts = attempts,
            retryDelayMillis = 1,
            connectTimeoutMillis = 200,
            chunkBytes = 64,
        )
        return printer to used
    }

    @Test fun connectsAfterRetriesAndPrintsTheWholeReceiptInChunks() = runBlocking {
        val good = FakeLink()
        val (printer, used) = printer(FakeLink(openFails = true), FakeLink(openFails = true), good)
        assertEquals(EscPosPrinter.READY, printer.connect())
        assertEquals(3, used.size)
        assertTrue(used[0].closed && used[1].closed && !good.closed)
        assertEquals(PrintResult.Success, printer.print(receipt))
        assertTrue(good.receiptBytes().contentEquals(EscPosEncoder().encode(receipt)))
        assertTrue("sent in chunks", good.writes > 3)
        val check = printer.diagnostics()
        assertEquals(PaperState.OK, check.paper)
        assertTrue(check.details.any { it == "Printer: MPT-II (Bluetooth)" })
        assertTrue(check.details.any { it == "Connection tries last time: 3 of 3" })
        assertTrue(check.details.any { it == "Paper sensor: answers" })
    }

    @Test fun givesUpAfterTheLastTryAndReportsDisconnected() = runBlocking {
        val (printer, used) = printer(FakeLink(openFails = true), FakeLink(openFails = true))
        assertEquals(PrinterStatus.Disconnected, printer.connect())
        assertEquals(3, used.size)
        assertEquals(PrintResult.Error(PrinterStatus.Disconnected), printer.print(receipt))
        assertTrue(printer.diagnostics().details.any { it == "Last problem: disconnected" })
    }

    @Test fun aHangingConnectTimesOutAndIsAborted() = runBlocking {
        val hanging = FakeLink(openBlocks = true)
        val (printer, _) = printer(hanging, attempts = 1)
        assertEquals(PrinterStatus.Timeout, printer.connect())
        assertTrue(hanging.closed)
    }

    @Test fun phoneSetupProblemsAreReportedWithoutTrying() = runBlocking {
        var problem: PrinterSetupProblem? = PrinterSetupProblem.BLUETOOTH_OFF
        val (printer, used) = printer(FakeLink(), problem = { problem })
        assertEquals(PrinterStatus.NeedsSetup(PrinterSetupProblem.BLUETOOTH_OFF), printer.connect())
        assertTrue(used.isEmpty())
        problem = null
        assertEquals(EscPosPrinter.READY, printer.connect())
    }

    @Test fun paperOutRefusesBeforeSendingAnyReceiptByte() = runBlocking {
        val link = FakeLink(reply = 0x72)
        val (printer, _) = printer(link)
        assertEquals(PaperState.OUT, printer.diagnostics().paper)
        assertEquals(PrintResult.Error(PrinterStatus.PaperOut), printer.print(receipt))
        assertEquals(0, link.receiptBytes().size)
    }

    @Test fun silentPrinterReportsPaperAsNotReportedAndStillPrints() = runBlocking {
        val link = FakeLink(reply = null)
        val (printer, _) = printer(link)
        val check = printer.diagnostics()
        assertEquals(PaperState.NOT_REPORTED, check.paper)
        assertTrue(check.details.contains("Paper sensor: does not answer"))
        assertEquals(PrintResult.Success, printer.print(receipt))
    }

    @Test fun aStaleLinkFoundBeforePrintingIsReconnectedOnceAndPrintsOnce() = runBlocking {
        val stale = FakeLink()
        val fresh = FakeLink()
        val (printer, _) = printer(stale, fresh)
        printer.connect()
        stale.failOnWrite = stale.writes + 1 // the printer was switched off: the status request fails
        assertEquals(PrintResult.Success, printer.print(receipt))
        assertEquals(0, stale.receiptBytes().size)
        assertTrue(fresh.receiptBytes().contentEquals(EscPosEncoder().encode(receipt)))
    }

    @Test fun aDropMidReceiptIsMaybePrintedAndNeverResent() = runBlocking {
        val link = FakeLink(failOnWrite = 4) // status request, two chunks, then the link drops
        val spare = FakeLink()
        val (printer, _) = printer(link, spare)
        assertEquals(PrintResult.Error(PrinterStatus.Disconnected, mayHavePrinted = true), printer.print(receipt))
        assertTrue(link.closed)
        assertEquals(0, spare.writes)
        assertEquals(PrinterStatus.Disconnected, printer.status())
        // The next explicit request reconnects with the spare link.
        assertEquals(PrintResult.Success, printer.print(receipt))
        assertTrue(spare.receiptBytes().contentEquals(EscPosEncoder().encode(receipt)))
    }

    @Test fun anInvalidBarcodeFailsBeforeConnecting() = runBlocking {
        val (printer, used) = printer(FakeLink())
        val bad = ReceiptDocument(listOf(ReceiptElement.Text("x"), ReceiptElement.Barcode("X".repeat(30))))
        val result = printer.print(bad)
        assertTrue(result is PrintResult.Error && !result.mayHavePrinted && result.status is PrinterStatus.Failed)
        assertTrue(used.isEmpty())
    }

    @Test fun closeIsTerminalAndCutterIsUnsupported() = runBlocking {
        val link = FakeLink()
        val (printer, _) = printer(link, FakeLink())
        printer.connect()
        assertTrue(printer.cut() is PrintResult.Unsupported)
        assertTrue(printer.openCashDrawer() is PrintResult.Unsupported)
        printer.close()
        assertTrue(link.closed)
        assertEquals(PrinterStatus.Disconnected, printer.connect())
        assertFalse(printer.print(receipt) is PrintResult.Success)
    }

    @Test fun saleReceiptFlowRecordsMaybePrintedWhenTheLinkDrops() = runBlocking {
        // VAN-017 flow on top of ESC/POS: a ready printer that drops mid-job is recorded as maybe printed.
        val receipt = SaleReceipt("sale-1", "TRIP-20261007-V014-1-7F3A9C21-0001", "Aling Nena Store (SAMPLE)",
            listOf(SaleReceiptLine(1, "p1", "Sunpride Pineapple Juice 1L", "PC", "3", 8_500, 25_500)),
            "PHP", 25_500, 30_000, 4_500, 1_791_338_400_000L)
        val outcomes = mutableListOf<PrintOutcome>()
        val log = object : ReceiptPrintLog {
            override suspend fun begin(saleId: String, explicit: Boolean, reasonCode: String?) = BeginPrint.Go(
                PrintAttempt("p1", saleId, PrintKind.ORIGINAL, 0, null, PrintOutcome.STARTED, 1),
                receipt, ReceiptHeader("Juan Dela Cruz (SAMPLE)", "TRIP-20261007-V014-1", "V014 NBC 1234"))
            override suspend fun finish(printId: String, outcome: PrintOutcome) { outcomes += outcome }
        }
        val link = FakeLink(failOnWrite = 3) // diagnostics probe, print probe, then the first receipt chunk fails
        val (printer, _) = printer(link)
        val result = ReceiptPrintFlow(printer, log).print("sale-1", explicit = false)
        assertTrue(result is PrintJobResult.Failed && result.mayHavePrinted)
        assertEquals(listOf(PrintOutcome.MAYBE_PRINTED), outcomes)
    }
}
