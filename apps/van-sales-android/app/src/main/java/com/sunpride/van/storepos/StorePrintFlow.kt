package com.sunpride.van.storepos

import com.sunpride.van.printing.*
import kotlinx.coroutines.CancellationException

sealed interface StoreBegin {
    data class Go(val attempt: PrintAttempt, val document: ReceiptDocument) : StoreBegin
    data class Refused(val refusal: PrintRefusal) : StoreBegin
}

/** The store counterpart of [ReceiptPrintLog]: same original/reprint rule, receipts built from the store journal. */
interface StorePrintLog {
    suspend fun begin(saleId: String, explicit: Boolean, reasonCode: String?): StoreBegin
    suspend fun finish(printId: String, outcome: PrintOutcome)
}

/** IP-P0: store receipts print automatically after the sale, then the cashier answers "Did it print?". */
class StorePrintFlow(private val printer: ReceiptPrinter, private val log: StorePrintLog) {
    suspend fun print(saleId: String, explicit: Boolean, reasonCode: String? = null): PrintJobResult {
        val check = printer.diagnostics()
        if (check.paper == PaperState.OUT || check.status == PrinterStatus.PaperOut) return PrintJobResult.Refused(PrintRefusal.PAPER_OUT)
        // Not connected: nothing can print, so nothing is recorded and the next try is still the original.
        if (check.status !is PrinterStatus.Ready) return PrintJobResult.Failed(check.status, null, false)
        val go = when (val begin = log.begin(saleId, explicit, reasonCode)) {
            is StoreBegin.Refused -> return PrintJobResult.Refused(begin.refusal)
            is StoreBegin.Go -> begin
        }
        val result = try { printer.print(go.document) } catch (e: CancellationException) { throw e } catch (e: Exception) {
            PrintResult.Error(PrinterStatus.Failed(e.javaClass.simpleName), mayHavePrinted = true)
        }
        val outcome = when (result) {
            PrintResult.Success -> PrintOutcome.PRINTED
            is PrintResult.Unsupported -> PrintOutcome.NOT_PRINTED
            is PrintResult.Error -> if (result.mayHavePrinted) PrintOutcome.MAYBE_PRINTED else PrintOutcome.NOT_PRINTED
        }
        log.finish(go.attempt.printId, outcome)
        val attempt = go.attempt.copy(outcome = outcome)
        return when (result) {
            PrintResult.Success -> PrintJobResult.Printed(attempt)
            is PrintResult.Unsupported -> PrintJobResult.Failed(PrinterStatus.Failed(result.feature), attempt, false)
            is PrintResult.Error -> PrintJobResult.Failed(result.status, attempt, result.mayHavePrinted)
        }
    }
}
