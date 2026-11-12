package com.sunpride.van.printing

import com.sunpride.van.data.SaleReceipt
import kotlinx.coroutines.CancellationException

/**
 * VAN-017 receipt printing and reprinting for sales already saved on this phone.
 *
 * Every attempt is written to the encrypted store as `started` BEFORE the printer is called, then finished as
 * printed / not printed / maybe printed. IP-P0 (SPEC 6.5): the handheld cannot see paper, so after each print the
 * seller answers "Did it print?". A re-send before "Yes, printed" is still the ORIGINAL; only prints after that
 * confirmation are REPRINTs, each needing an explicit request with a reason, limited per sale.
 */
enum class PrintKind(val wire: String) { ORIGINAL("original"), REPRINT("reprint"), VOID("void");
    companion object { fun of(wire: String) = entries.single { it.wire == wire } } }

enum class PrintOutcome(val wire: String) { STARTED("started"), PRINTED("printed"), NOT_PRINTED("not_printed"), MAYBE_PRINTED("maybe_printed"),
    /** The seller tapped "Yes, printed". From here on, another copy is a REPRINT. */
    CONFIRMED("confirmed"),
    /** The seller tapped "Skip, no paper": the receipt is recorded as unprinted for the office (local only). */
    SKIPPED("skipped");
    companion object { fun of(wire: String) = entries.single { it.wire == wire } } }

/** One recorded print of a saved sale. [copyNumber] is 0 for the original and 1.. for reprints. */
data class PrintAttempt(val printId: String, val saleId: String, val kind: PrintKind, val copyNumber: Int, val reason: String?,
    val outcome: PrintOutcome, val startedAt: Long, val finishedAt: Long? = null) {
    /** True unless the printer refused before any paper could move, or the seller skipped it for lack of paper. */
    val mayHaveReachedPaper: Boolean get() = outcome != PrintOutcome.NOT_PRINTED && outcome != PrintOutcome.SKIPPED
    /** The seller said it printed. */
    val confirmed: Boolean get() = outcome == PrintOutcome.CONFIRMED
}

data class ReprintReason(val code: String, val label: String)

enum class PrintRefusal {
    /** An automatic print after saving found the receipt already printed: only an explicit reprint prints again. */
    ALREADY_PRINTED,
    REASON_REQUIRED,
    LIMIT_REACHED,
    /** Before "Yes, printed": the receipt was already sent [ReprintRules.MAX_REPRINTS] extra times; answer Yes or Skip first. */
    CONFIRM_FIRST,
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
        val live = history.filter { it.kind != PrintKind.VOID }
        val lastConfirmed = live.filter { it.confirmed }.maxByOrNull { it.startedAt }
        if (lastConfirmed == null) {
            // Nothing is confirmed yet: the automatic print happens once, but a seller's "Print again" is still the original.
            if (!explicit && live.any { it.mayHaveReachedPaper }) return PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED)
            // IP-P0: re-sends before "Yes, printed" are capped like reprints, so a seller cannot loop out originals.
            if (unconfirmedResends(live) >= MAX_REPRINTS) return PrintDecision.Refused(PrintRefusal.CONFIRM_FIRST)
            return PrintDecision.Print(PrintKind.ORIGINAL, 0, null)
        }
        if (!explicit) return PrintDecision.Refused(PrintRefusal.ALREADY_PRINTED)
        // A reprint that was sent but not yet confirmed is re-sent as the same copy: it does not use another reprint.
        pendingReprint(live)?.let { return PrintDecision.Print(PrintKind.REPRINT, it.copyNumber, it.reason) }
        if (REASONS.none { it.code == reasonCode }) return PrintDecision.Refused(PrintRefusal.REASON_REQUIRED)
        val confirmedReprints = live.count { it.confirmed && it.kind == PrintKind.REPRINT }
        if (confirmedReprints >= MAX_REPRINTS) return PrintDecision.Refused(PrintRefusal.LIMIT_REACHED)
        return PrintDecision.Print(PrintKind.REPRINT, confirmedReprints + 1, reasonCode)
    }
    /**
     * Copies sent to the printer for a receipt nobody has confirmed, beyond the first. A copy counts once it may have
     * reached paper or was skipped for lack of paper (so "Skip, no paper" then print is a re-send); a copy the printer
     * refused before any paper moved is free.
     */
    private fun unconfirmedResends(live: List<PrintAttempt>): Int =
        maxOf(0, live.count { it.kind == PrintKind.ORIGINAL && (it.mayHaveReachedPaper || it.outcome == PrintOutcome.SKIPPED) } - 1)
    /** The latest reprint sent after the last confirmation and not yet confirmed (it may or may not be on paper). */
    private fun pendingReprint(live: List<PrintAttempt>): PrintAttempt? {
        val lastConfirmed = live.filter { it.confirmed }.maxByOrNull { it.startedAt } ?: return null
        return live.filter { it.kind == PrintKind.REPRINT && it.startedAt > lastConfirmed.startedAt && it.mayHaveReachedPaper && !it.confirmed }.maxByOrNull { it.startedAt }
    }
    /** Reprints still available: confirmed ones and one sent-but-unconfirmed copy use up the cap. */
    fun remaining(history: List<PrintAttempt>): Int {
        val live = history.filter { it.kind != PrintKind.VOID }
        if (live.none { it.confirmed }) return maxOf(0, MAX_REPRINTS - unconfirmedResends(live))
        val used = live.count { it.confirmed && it.kind == PrintKind.REPRINT } + if (pendingReprint(live) != null) 1 else 0
        return maxOf(0, MAX_REPRINTS - used)
    }
    /**
     * VAN-051: what "Did it print?" offers, read from the saved history (not from the last print's result), so the
     * re-send limit shows on the sheet itself every time it is open. Null = Print again is offered with no limit note.
     * Before "Yes, printed" the original may be sent [MAX_REPRINTS] more times; after that only Yes or Skip remain.
     */
    fun printAgainLeft(history: List<PrintAttempt>): Int? {
        val live = history.filter { it.kind != PrintKind.VOID }
        if (live.isEmpty() || live.any { it.confirmed }) return null
        return maxOf(0, MAX_REPRINTS - unconfirmedResends(live))
    }
    /** Sent to the printer but the seller has not said whether it printed. */
    fun needsConfirmation(history: List<PrintAttempt>): Boolean {
        val live = history.filter { it.kind != PrintKind.VOID }
        val last = live.maxByOrNull { it.startedAt } ?: return false
        return last.mayHaveReachedPaper && !last.confirmed
    }
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
    /** The seller's answer to "Did it print?": [PrintOutcome.CONFIRMED] or [PrintOutcome.SKIPPED] for the latest unconfirmed attempt. */
    suspend fun settle(saleId: String, outcome: PrintOutcome) {}
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
