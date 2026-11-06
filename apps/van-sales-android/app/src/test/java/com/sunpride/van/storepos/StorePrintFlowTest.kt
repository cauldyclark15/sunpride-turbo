package com.sunpride.van.storepos

import com.sunpride.van.printing.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** IP-P0 (SPEC 6.5): store receipts follow the same rule as the van: re-send is ORIGINAL until "Yes, printed". */
class StorePrintFlowTest {
    private class MemoryStoreLog : StorePrintLog {
        val attempts = mutableListOf<PrintAttempt>()
        override suspend fun begin(saleId: String, explicit: Boolean, reasonCode: String?): StoreBegin =
            when (val d = ReprintRules.decide(attempts, explicit, reasonCode)) {
                is PrintDecision.Refused -> StoreBegin.Refused(d.refusal)
                is PrintDecision.Print -> {
                    val a = PrintAttempt("p${attempts.size}", saleId, d.kind, d.copyNumber, d.reason, PrintOutcome.STARTED, 100L + attempts.size)
                    attempts += a
                    StoreBegin.Go(a, ReceiptDocument(listOf(ReceiptElement.Text(if (d.kind == PrintKind.REPRINT) "REPRINT" else "ORIGINAL")), d.kind == PrintKind.REPRINT))
                }
            }
        override suspend fun finish(printId: String, outcome: PrintOutcome) {
            val i = attempts.indexOfFirst { it.printId == printId }
            attempts[i] = attempts[i].copy(outcome = outcome)
        }
        fun settle(outcome: PrintOutcome) { val i = attempts.lastIndex; attempts[i] = attempts[i].copy(outcome = outcome) }
    }

    @Test fun autoPrintThenPrintAgainIsOriginalThenConfirmedMakesReprints() = runBlocking {
        val log = MemoryStoreLog(); val printer = FakeReceiptPrinter()
        val flow = StorePrintFlow(printer, log)
        val first = flow.print("sale", explicit = false) as PrintJobResult.Printed
        assertEquals(PrintKind.ORIGINAL, first.attempt.kind)
        val again = flow.print("sale", explicit = true) as PrintJobResult.Printed
        assertEquals(PrintKind.ORIGINAL, again.attempt.kind)
        assertEquals(listOf(false, false), printer.documents.map { it.isReprint })
        log.settle(PrintOutcome.CONFIRMED)
        assertEquals(PrintJobResult.Refused(PrintRefusal.REASON_REQUIRED), flow.print("sale", explicit = true))
        val copy = flow.print("sale", explicit = true, reasonCode = "customer_copy") as PrintJobResult.Printed
        assertEquals(PrintKind.REPRINT, copy.attempt.kind)
        assertTrue(printer.documents.last().isReprint)
    }

    @Test fun nothingIsRecordedWhenThePrinterIsNotReadyOrOutOfPaper() = runBlocking {
        val log = MemoryStoreLog()
        assertTrue(StorePrintFlow(NoPrinter(), log).print("sale", false) is PrintJobResult.Failed)
        assertEquals(PrintJobResult.Refused(PrintRefusal.PAPER_OUT), StorePrintFlow(FakeReceiptPrinter(PaperState.OUT), log).print("sale", false))
        assertTrue(log.attempts.isEmpty())
    }

    @Test fun aRefusedPrintLeavesTheNextOneTheOriginal() = runBlocking {
        val log = MemoryStoreLog(); val fake = FakeReceiptPrinter()
        fake.nextFailure = PrintResult.Error(PrinterStatus.Disconnected, mayHavePrinted = false)
        val failed = StorePrintFlow(fake, log).print("sale", false) as PrintJobResult.Failed
        assertEquals(PrintOutcome.NOT_PRINTED, failed.attempt!!.outcome)
        val next = StorePrintFlow(fake, log).print("sale", false) as PrintJobResult.Printed
        assertEquals(PrintKind.ORIGINAL, next.attempt.kind)
    }
}
