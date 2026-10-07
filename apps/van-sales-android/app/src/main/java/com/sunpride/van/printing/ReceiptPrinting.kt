package com.sunpride.van.printing

data class SavedReceiptOutcome<T>(val saved: T, val printing: PrintResult)

/** Persist FIRST: a sale must be durably saved before any printer call.
 * A paper, service or connection failure must not roll back the sale or submit it twice.
 * Pass the persisted record to the builder. Do not auto-retry ambiguous errors: the operator
 * must explicitly request [reprint], which marks the document REPRINT, without saving again.
 */
class ReceiptPrinting(private val printer: ReceiptPrinter) {
    suspend fun <T> saveThenPrint(
        save: suspend () -> T,
        build: (T) -> ReceiptDocument,
    ): SavedReceiptOutcome<T> {
        val saved = save() // If persistence fails, no connect/print call is made.
        return SavedReceiptOutcome(saved, printSaved(build(saved)))
    }

    suspend fun printSaved(document: ReceiptDocument): PrintResult = when (val state = printer.connect()) {
        is PrinterStatus.Ready -> printer.print(document)
        else -> PrintResult.Error(state)
    }
    suspend fun reprint(document: ReceiptDocument): PrintResult = printSaved(document.markedReprint())
}
