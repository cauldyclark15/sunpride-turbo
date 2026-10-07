package com.sunpride.van.printing

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.SaleReceipt
import com.sunpride.van.data.SaleReceiptLine
import com.sunpride.van.ui.VanRules
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** VAN-017: authorized reprint with a REPRINT marker; every attempt recorded before the printer is called. */
class ReceiptReprintTest {
    private val receipt = SaleReceipt("sale-1", "TRIP-20261007-V014-1-7F3A9C21-0001", "Aling Nena Store",
        listOf(SaleReceiptLine(1, "p1", "Sunpride Pineapple Juice 1L", "PC", "3", 8_500, 25_500),
            SaleReceiptLine(2, "p2", "Sunpride Pineapple Chunks 227g (Extra long product name for wrapping)", "CAN", "2", 4_250, 8_500)),
        "PHP", 34_000, 50_000, 16_000, 1_791_338_400_000L)
    private val header = ReceiptHeader("Juan Dela Cruz", "TRIP-20261007-V014-1", "V014 NBC 1234")

    private fun attempt(kind: PrintKind, outcome: PrintOutcome, copy: Int = 0) = PrintAttempt("id-$kind-$copy-$outcome", "sale-1", kind, copy, null, outcome, 1)

    /** In-memory stand-in for the encrypted log; [snapshotAtPrint] proves `started` is written before printing. */
    private class MemoryLog(val receipt: SaleReceipt, val header: ReceiptHeader, var refusal: PrintRefusal? = null) : ReceiptPrintLog {
        val attempts = mutableListOf<PrintAttempt>()
        override suspend fun begin(saleId: String, explicit: Boolean, reasonCode: String?): BeginPrint {
            refusal?.let { return BeginPrint.Refused(it) }
            return when (val d = ReprintRules.decide(attempts, explicit, reasonCode)) {
                is PrintDecision.Refused -> BeginPrint.Refused(d.refusal)
                is PrintDecision.Print -> {
                    val a = PrintAttempt("print-${attempts.size}", saleId, d.kind, d.copyNumber, d.reason, PrintOutcome.STARTED, 10L + attempts.size)
                    attempts += a; BeginPrint.Go(a, receipt, header)
                }
            }
        }
        override suspend fun finish(printId: String, outcome: PrintOutcome) {
            val i = attempts.indexOfFirst { it.printId == printId }
            check(attempts[i].outcome == PrintOutcome.STARTED)
            attempts[i] = attempts[i].copy(outcome = outcome, finishedAt = 99)
        }
    }
    private class SpyPrinter(val delegate: FakeReceiptPrinter, val log: MemoryLog) : ReceiptPrinter by delegate {
        val snapshotAtPrint = mutableListOf<List<PrintOutcome>>()
        override suspend fun print(doc: ReceiptDocument): PrintResult { snapshotAtPrint += log.attempts.map { it.outcome }; return delegate.print(doc) }
    }

    @Test fun firstCopyIsTheOriginalAndOnlyAnExplicitReasonedRequestPrintsAgain() {
        assertEquals(PrintDecision.Print(PrintKind.ORIGINAL, 0, null), ReprintRules.decide(emptyList(), explicit = false, reasonCode = null))
        // A print the printer refused before paper moved does not use up the original.
        assertEquals(PrintDecision.Print(PrintKind.ORIGINAL, 0, null),
            ReprintRules.decide(listOf(attempt(PrintKind.ORIGINAL, PrintOutcome.NOT_PRINTED)), explicit = true, reasonCode = null))
        val printed = listOf(attempt(PrintKind.ORIGINAL, PrintOutcome.PRINTED))
        assertEquals(PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED), ReprintRules.decide(printed, explicit = false, reasonCode = "customer_copy"))
        assertEquals(PrintDecision.Refused(PrintRefusal.REASON_REQUIRED), ReprintRules.decide(printed, explicit = true, reasonCode = null))
        assertEquals(PrintDecision.Refused(PrintRefusal.REASON_REQUIRED), ReprintRules.decide(printed, explicit = true, reasonCode = "made_up"))
        assertEquals(PrintDecision.Print(PrintKind.REPRINT, 1, "customer_copy"), ReprintRules.decide(printed, explicit = true, reasonCode = "customer_copy"))
    }

    @Test fun unfinishedAndAmbiguousAttemptsCountAsPrintedAndReprintsAreLimited() {
        // The app died mid-print: the copy may be on paper, so the next one must say REPRINT.
        assertEquals(PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED),
            ReprintRules.decide(listOf(attempt(PrintKind.ORIGINAL, PrintOutcome.STARTED)), explicit = false, reasonCode = null))
        val history = listOf(attempt(PrintKind.ORIGINAL, PrintOutcome.MAYBE_PRINTED), attempt(PrintKind.REPRINT, PrintOutcome.PRINTED, 1),
            attempt(PrintKind.REPRINT, PrintOutcome.NOT_PRINTED, 2), attempt(PrintKind.REPRINT, PrintOutcome.STARTED, 2))
        assertEquals(PrintDecision.Print(PrintKind.REPRINT, 3, "unreadable"), ReprintRules.decide(history, true, "unreadable"))
        assertEquals(1, ReprintRules.remaining(history))
        val full = history + attempt(PrintKind.REPRINT, PrintOutcome.PRINTED, 3)
        assertEquals(PrintDecision.Refused(PrintRefusal.LIMIT_REACHED), ReprintRules.decide(full, true, "customer_copy"))
        assertEquals(0, ReprintRules.remaining(full))
    }

    @Test fun printFlowRecordsStartedBeforePrintingAndMarksReprints() = runBlocking {
        val log = MemoryLog(receipt, header)
        val printer = SpyPrinter(FakeReceiptPrinter(), log)
        val flow = ReceiptPrintFlow(printer, log) { 1_791_342_000_000L }
        val original = flow.print("sale-1", explicit = false)
        assertTrue(original is PrintJobResult.Printed)
        assertEquals(listOf(listOf(PrintOutcome.STARTED)), printer.snapshotAtPrint)
        assertEquals(PrintJobResult.Refused(PrintRefusal.ALREADY_PRINTED), flow.print("sale-1", explicit = false))
        assertEquals(PrintJobResult.Refused(PrintRefusal.REASON_REQUIRED), flow.print("sale-1", explicit = true))
        val copy = flow.print("sale-1", explicit = true, reasonCode = "paper_problem") as PrintJobResult.Printed
        assertEquals(PrintKind.REPRINT, copy.attempt.kind); assertEquals(1, copy.attempt.copyNumber)
        assertEquals(listOf(PrintOutcome.PRINTED, PrintOutcome.PRINTED), log.attempts.map { it.outcome })
        val docs = printer.delegate.documents
        assertFalse(docs[0].isReprint); assertTrue(docs[1].isReprint)
        val lines = ReceiptLayoutFormatter().format(docs[1]).filterIsInstance<ReceiptCommand.Line>().map { it.text }
        assertEquals("REPRINT", lines.first())
        assertTrue(lines.contains("REPRINT - COPY 1"))
        assertTrue(lines.contains("Reason: Paper jammed or ran out"))
        assertTrue(lines.contains("Reprinted: 2026-10-07 11:00"))
        assertTrue(lines.contains("** REPRINT - NOT ORIGINAL **"))
        assertFalse(ReceiptLayoutFormatter().format(docs[0]).filterIsInstance<ReceiptCommand.Line>().any { it.text.contains("REPRINT") })
        repeat(2) { assertTrue(flow.print("sale-1", true, "customer_copy") is PrintJobResult.Printed) }
        assertEquals(PrintJobResult.Refused(PrintRefusal.LIMIT_REACHED), flow.print("sale-1", true, "customer_copy"))
        assertEquals(4, printer.delegate.documents.size)
    }

    @Test fun printerProblemsNeverRecordAFalseOriginal() = runBlocking {
        // Not connected: nothing recorded, the next print is still the original.
        val log = MemoryLog(receipt, header)
        assertEquals(PrintJobResult.Failed(PrinterStatus.Unavailable, null, false), ReceiptPrintFlow(NoPrinter(), log).print("sale-1", false))
        assertTrue(log.attempts.isEmpty())
        // Paper reported out: refused before anything is recorded.
        val fake = FakeReceiptPrinter(PaperState.OUT)
        assertEquals(PrintJobResult.Refused(PrintRefusal.PAPER_OUT), ReceiptPrintFlow(fake, log).print("sale-1", false))
        assertTrue(log.attempts.isEmpty())
        // Refused before beginWork: recorded as not printed, the next print is still the original.
        fake.paper = PaperState.OK
        fake.nextFailure = PrintResult.Error(PrinterStatus.Disconnected, mayHavePrinted = false)
        val notPrinted = ReceiptPrintFlow(fake, log).print("sale-1", false) as PrintJobResult.Failed
        assertEquals(PrintOutcome.NOT_PRINTED, notPrinted.attempt!!.outcome)
        // Failed mid-job: may be on paper, so any further copy is a REPRINT.
        fake.nextFailure = PrintResult.Error(PrinterStatus.Disconnected, mayHavePrinted = true)
        val partial = ReceiptPrintFlow(fake, log).print("sale-1", true) as PrintJobResult.Failed
        assertEquals(PrintKind.ORIGINAL, partial.attempt!!.kind); assertTrue(partial.mayHavePrinted)
        assertEquals(PrintJobResult.Refused(PrintRefusal.ALREADY_PRINTED), ReceiptPrintFlow(fake, log).print("sale-1", false))
        val reprint = ReceiptPrintFlow(fake, log).print("sale-1", true, "unreadable") as PrintJobResult.Printed
        assertEquals(PrintKind.REPRINT, reprint.attempt.kind)
        assertEquals(listOf(PrintOutcome.NOT_PRINTED, PrintOutcome.MAYBE_PRINTED, PrintOutcome.PRINTED), log.attempts.map { it.outcome })
        // A store refusal (other trip, held phone) prints nothing.
        val held = MemoryLog(receipt, header, PrintRefusal.HELD)
        assertEquals(PrintJobResult.Refused(PrintRefusal.HELD), ReceiptPrintFlow(FakeReceiptPrinter(), held).print("sale-1", true, "customer_copy"))
    }

    @Test fun saleReceiptFits58mmAndCarriesTheSaleFacts() {
        val doc = SaleReceiptDocuments.build(receipt, header, attempt(PrintKind.ORIGINAL, PrintOutcome.STARTED), 0L)
        val commands = ReceiptLayoutFormatter().format(doc)
        val lines = commands.filterIsInstance<ReceiptCommand.Line>()
        lines.forEach { val width = if (it.style.doubleWidth) 16 else 32; assertTrue("too wide: ${it.text}", it.text.codePointCount(0, it.text.length) <= width) }
        val text = lines.joinToString("\n") { it.text }
        listOf("DELIVERY RECEIPT", "Customer: Aling Nena Store", "Seller: Juan Dela Cruz", "Trip: TRIP-20261007-V014-1",
            "Date: 2026-10-07 10:00", "Payment: Paid").forEach { assertTrue(it, text.contains(it)) }
        assertTrue(lines.any { it.text.startsWith("TOTAL") && it.text.endsWith("P340.00") && it.style.bold })
        assertTrue(lines.any { it.text.startsWith("Change") && it.text.endsWith("P160.00") })
        assertTrue(lines.any { it.text.startsWith("  3 PC x P85.00") && it.text.endsWith("P255.00") })
        assertTrue(lines.joinToString("") { it.text }.contains(TestReceipts.DISCLAIMER))
        assertFalse(text.contains("₱"))
        assertEquals(receipt.receiptNumber, commands.filterIsInstance<ReceiptCommand.Qr>().single().value.data)
        // Credit and reference payments print their own state.
        val credit = SaleReceiptDocuments.build(receipt.copy(paymentKind = PaymentKind.CREDIT, paymentLabel = "Credit", paymentStatus = "on_account", dueDate = "2026-11-06"),
            header, attempt(PrintKind.ORIGINAL, PrintOutcome.STARTED), 0L)
        val creditText = ReceiptLayoutFormatter().format(credit).filterIsInstance<ReceiptCommand.Line>().joinToString("\n") { it.text }
        assertTrue(creditText.contains("Payment: On account\nDue: 2026-11-06")); assertFalse(creditText.contains("Change"))
    }

    @Test fun printMessagesAreSellerWords() {
        val a = PrintAttempt("p", "s", PrintKind.REPRINT, 2, "customer_copy", PrintOutcome.PRINTED, 1)
        assertEquals("Reprint copy 2 printed. It is marked REPRINT.", VanRules.printMessage(PrintJobResult.Printed(a)))
        assertEquals("Printer not ready: no printer on this phone. The sale is saved. Check the printer, then print again.",
            VanRules.printMessage(PrintJobResult.Failed(PrinterStatus.Unavailable, null, false)))
        assertTrue(VanRules.printMessage(PrintJobResult.Failed(PrinterStatus.Disconnected, a, true)).contains("marked REPRINT"))
        assertEquals("The printer is out of paper. Load paper, then print again.", VanRules.printMessage(PrintJobResult.Refused(PrintRefusal.PAPER_OUT)))
        assertTrue(PrinterWords.paper(PaperState.NOT_REPORTED).startsWith("Not reported"))
    }
}
