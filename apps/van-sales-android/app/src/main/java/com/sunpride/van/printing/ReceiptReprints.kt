package com.sunpride.van.printing

import com.sunpride.van.data.SaleReceipt
import kotlinx.coroutines.CancellationException

/**
 * VAN-017 receipt printing and reprinting for sales already saved on this phone.
 *
 * Every attempt is written to the encrypted store as `started` BEFORE the printer is called, then finished as
 * printed / not printed / maybe printed. An attempt that never finished (the app died mid-print) counts as maybe
 * printed, so the next copy is always marked REPRINT. Only the first copy that may have reached paper is the
 * original; every later copy needs an explicit seller request with a reason and is limited per sale.
 */
enum class PrintKind(val wire: String) { ORIGINAL("original"), REPRINT("reprint"), VOID("void");
    companion object { fun of(wire: String) = entries.single { it.wire == wire } } }

enum class PrintOutcome(val wire: String) { STARTED("started"), PRINTED("printed"), NOT_PRINTED("not_printed"), MAYBE_PRINTED("maybe_printed");
    companion object { fun of(wire: String) = entries.single { it.wire == wire } } }

/** One recorded print of a saved sale. [copyNumber] is 0 for the original and 1.. for reprints. */
data class PrintAttempt(val printId: String, val saleId: String, val kind: PrintKind, val copyNumber: Int, val reason: String?,
    val outcome: PrintOutcome, val startedAt: Long, val finishedAt: Long? = null) {
    /** True unless the printer refused before any paper could move. */
    val mayHaveReachedPaper: Boolean get() = outcome != PrintOutcome.NOT_PRINTED
}

data class ReprintReason(val code: String, val label: String)

enum class PrintRefusal {
    /** An automatic print after saving found the receipt already printed: only an explicit reprint prints again. */
    ALREADY_PRINTED,
    REASON_REQUIRED,
    LIMIT_REACHED,
    /** Receipts can be reprinted on the phone only for the trip it is on now; older ones come from the office. */
    NOT_THIS_TRIP,
    SALE_NOT_FOUND,
    /** Signed-out / held work on this phone cannot print. */
    HELD,
    PAPER_OUT,
}

sealed interface PrintDecision {
    data class Print(val kind: PrintKind, val copyNumber: Int, val reason: String?) : PrintDecision
    data class Refused(val refusal: PrintRefusal) : PrintDecision
}

/** Defaults until Sunpride sets its own reprint policy (documented in the van printer guide). */
object ReprintRules {
    const val MAX_REPRINTS = 3
    val REASONS = listOf(
        ReprintReason("customer_copy", "Customer needs another copy"),
        ReprintReason("paper_problem", "Paper jammed or ran out"),
        ReprintReason("unreadable", "Print is faded or hard to read"),
        ReprintReason("office_copy", "Copy for the office"),
    )
    fun reasonLabel(code: String?): String? = REASONS.firstOrNull { it.code == code }?.label

    fun decide(history: List<PrintAttempt>, explicit: Boolean, reasonCode: String?, voided: Boolean = false): PrintDecision {
        if (voided) {
            val count = history.count { it.kind == PrintKind.VOID && it.mayHaveReachedPaper }
            if (count > 0 && !explicit) return PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED)
            if (count >= MAX_REPRINTS+1) return PrintDecision.Refused(PrintRefusal.LIMIT_REACHED)
            return PrintDecision.Print(PrintKind.VOID,count+1,null)
        }
        val reached = history.filter { it.kind != PrintKind.VOID && it.mayHaveReachedPaper }
        if (reached.isEmpty()) return PrintDecision.Print(PrintKind.ORIGINAL, 0, null)
        if (!explicit) return PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED)
        if (REASONS.none { it.code == reasonCode }) return PrintDecision.Refused(PrintRefusal.REASON_REQUIRED)
        val reprints = reached.count { it.kind == PrintKind.REPRINT }
        if (reprints >= MAX_REPRINTS) return PrintDecision.Refused(PrintRefusal.LIMIT_REACHED)
        return PrintDecision.Print(PrintKind.REPRINT, reprints + 1, reasonCode)
    }
    fun remaining(history: List<PrintAttempt>): Int =
        maxOf(0, MAX_REPRINTS - history.count { it.mayHaveReachedPaper && it.kind == PrintKind.REPRINT })
}

/** Who sold and on which trip, printed in the receipt header. */
data class ReceiptHeader(val sellerName: String?, val tripNumber: String?, val truck: String?)

data class SaleVoidInfo(val reasonCode: String, val voidedAt: Long, val approved: Boolean)

sealed interface BeginPrint {
    data class Go(val attempt: PrintAttempt, val receipt: SaleReceipt, val header: ReceiptHeader, val void: SaleVoidInfo? = null) : BeginPrint
    data class Refused(val refusal: PrintRefusal) : BeginPrint
}

/** The scoped, encrypted print history. [begin] authorizes, decides and records `started` in one transaction. */
interface ReceiptPrintLog {
    suspend fun begin(saleId: String, explicit: Boolean, reasonCode: String?): BeginPrint
    suspend fun finish(printId: String, outcome: PrintOutcome)
}

sealed interface PrintJobResult {
    data class Printed(val attempt: PrintAttempt) : PrintJobResult
    /** [attempt] is null when the printer was not ready and nothing was recorded. */
    data class Failed(val status: PrinterStatus, val attempt: PrintAttempt?, val mayHavePrinted: Boolean) : PrintJobResult
    data class Refused(val refusal: PrintRefusal) : PrintJobResult
}

class ReceiptPrintFlow(private val printer: ReceiptPrinter, private val log: ReceiptPrintLog, private val clock: () -> Long = System::currentTimeMillis) {
    /** [explicit] = the seller asked (Print/Reprint button); false = the automatic print right after saving. */
    suspend fun print(saleId: String, explicit: Boolean, reasonCode: String? = null): PrintJobResult {
        val check = printer.diagnostics()
        if (check.paper == PaperState.OUT || check.status == PrinterStatus.PaperOut) return PrintJobResult.Refused(PrintRefusal.PAPER_OUT)
        // Not connected: nothing can print, so nothing is recorded and the next try is still the original.
        if (check.status !is PrinterStatus.Ready) return PrintJobResult.Failed(check.status, null, false)
        val go = when (val begin = log.begin(saleId, explicit, reasonCode)) {
            is BeginPrint.Refused -> return PrintJobResult.Refused(begin.refusal)
            is BeginPrint.Go -> begin
        }
        val document = SaleReceiptDocuments.build(go.receipt, go.header, go.attempt, clock(), void = go.void)
        // A cancelled job stays `started`, which already counts as maybe printed.
        val result = try { printer.print(document) } catch (e: CancellationException) { throw e } catch (e: Exception) {
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
