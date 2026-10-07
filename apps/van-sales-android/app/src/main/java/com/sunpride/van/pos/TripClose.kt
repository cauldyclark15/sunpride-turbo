package com.sunpride.van.pos

import com.sunpride.van.data.TripClosePolicy
import com.sunpride.van.data.VanPolicy
import java.util.UUID

/**
 * VAN-024 closing the trip on the handheld. The phone may close the trip only when every required step is done
 * (trip on the road, phone not paused, cash and stock counted, nothing still waiting to send, sales and truck stock
 * agree) and, per policy, the seller has confirmed the open exceptions shown at close. Display/validation only:
 * the store gathers the facts and repeats these rules in the saving transaction.
 */
enum class CloseStep { TRIP_STARTED, PHONE_ACTIVE, CASH_COUNTED, STOCK_COUNTED, UPLOADS_SENT, SALES_MATCH_STOCK }

/** One checklist line: [required] by policy, [done] on this phone; [count] says how many things are still open. */
data class CloseStepState(val step: CloseStep, val required: Boolean, val done: Boolean, val count: Int = 0) {
    val blocking: Boolean get() = required && !done
}

/** Things the seller must look at before closing; none stops the close by itself (the office follows them up). */
enum class CloseExceptionKind(val wire: String) {
    /** Sales saved on this trip whose receipt never reached paper. */
    UNPRINTED_RECEIPTS("unprinted_receipts"),
    /** Operations the office refused or found in conflict (they wait in "to review"). */
    OFFICE_REFUSED("office_refused"),
    /** Counted cash differs from the expected cash ([CloseException.amount] = signed centavos). */
    CASH_DIFFERENCE("cash_difference"),
    /** Stock count lines that differed ([CloseException.amount] = lines). */
    STOCK_DIFFERENCE("stock_difference")
}

data class CloseException(val kind: CloseExceptionKind, val amount: Long)

/** What the store read from this phone's partition for the current trip. */
data class TripCloseFacts(
    val tripOnRoad: Boolean,
    val held: Boolean,
    val cashCounted: Boolean,
    val stockCounted: Boolean,
    /** Operations the gateway accepts that are still pending or sending (parked work is not counted). */
    val waitingUploads: Int,
    /** VAN-018 disagreements between saved sales and their truck-stock deductions. */
    val saleStockIssues: Int,
    val unprintedReceipts: Int,
    val officeRefused: Int,
    val cashVarianceMinor: Long?,
    val stockVarianceLines: Int?
)

data class TripCloseChecklist(val steps: List<CloseStepState>, val exceptions: List<CloseException>) {
    val blockers: List<CloseStepState> get() = steps.filter { it.blocking }
    val ready: Boolean get() = blockers.isEmpty()
    /** Fingerprint of the exceptions the seller confirmed; any change before saving needs a fresh confirmation. */
    val reviewCode: String get() = exceptions.joinToString(";") { "${it.kind.wire}=${it.amount}" }
}

enum class CloseProblem {
    NOT_ON_ROUTE, HELD, ALREADY_CLOSED, CASH_NOT_COUNTED, STOCK_NOT_COUNTED, UPLOADS_WAITING, SALES_STOCK_DISAGREE,
    REVIEW_REQUIRED, EXCEPTIONS_CHANGED, CLOSE_INVALID, ODOMETER_INVALID, NOTE_INVALID
}

class TripCloseRefused(val problem: CloseProblem) : IllegalStateException(problem.name)

/**
 * What the seller saves. [reviewCode] is [TripCloseChecklist.reviewCode] of the exceptions the screen showed when
 * the seller ticked "I have checked these" (null when nothing was confirmed).
 */
data class TripCloseRequest(val closeId: String, val reviewCode: String?, val endOdometerKm: Double?, val note: String?)

data class TripCloseResult(
    val closeId: String,
    val tripNumber: String,
    val exceptions: List<CloseException>,
    val reviewed: Boolean,
    val endOdometerKm: Double?,
    val note: String?,
    /** Operations of this trip saved on the phone and listed in the close record (sales, counts, damage, …). */
    val operationCount: Int,
    val createdAt: Long,
    val replay: Boolean
)

data class TripCloseSummary(
    val tripId: String,
    val tripNumber: String,
    val startOdometerKm: Double?,
    val checklist: TripCloseChecklist,
    val saved: TripCloseResult?
)

object TripCloseRules {
    const val MAX_NOTE = 300
    const val MAX_ODOMETER_KM = 10_000_000.0
    private val UUID_V4 = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")

    /** A server or cache without the rule gets the strictest checks (fail closed). */
    fun policy(policy: VanPolicy?): TripClosePolicy = policy?.tripClose ?: TripClosePolicy.STRICT

    fun newCloseId(): String = UUID.randomUUID().toString()
    fun validId(id: String): Boolean = UUID_V4.matches(id)

    fun checklist(facts: TripCloseFacts, policy: TripClosePolicy): TripCloseChecklist {
        val steps = listOf(
            CloseStepState(CloseStep.TRIP_STARTED, true, facts.tripOnRoad),
            CloseStepState(CloseStep.PHONE_ACTIVE, true, !facts.held),
            CloseStepState(CloseStep.CASH_COUNTED, policy.requireCashCount, facts.cashCounted),
            CloseStepState(CloseStep.STOCK_COUNTED, policy.requireStockCount, facts.stockCounted),
            CloseStepState(CloseStep.UPLOADS_SENT, policy.requireUploadsSent, facts.waitingUploads == 0, facts.waitingUploads),
            CloseStepState(CloseStep.SALES_MATCH_STOCK, true, facts.saleStockIssues == 0, facts.saleStockIssues)
        )
        val exceptions = buildList {
            if (facts.unprintedReceipts > 0) add(CloseException(CloseExceptionKind.UNPRINTED_RECEIPTS, facts.unprintedReceipts.toLong()))
            if (facts.officeRefused > 0) add(CloseException(CloseExceptionKind.OFFICE_REFUSED, facts.officeRefused.toLong()))
            facts.cashVarianceMinor?.takeIf { it != 0L }?.let { add(CloseException(CloseExceptionKind.CASH_DIFFERENCE, it)) }
            facts.stockVarianceLines?.takeIf { it != 0 }?.let { add(CloseException(CloseExceptionKind.STOCK_DIFFERENCE, it.toLong())) }
        }
        return TripCloseChecklist(steps, exceptions)
    }

    fun problem(step: CloseStep): CloseProblem = when (step) {
        CloseStep.TRIP_STARTED -> CloseProblem.NOT_ON_ROUTE
        CloseStep.PHONE_ACTIVE -> CloseProblem.HELD
        CloseStep.CASH_COUNTED -> CloseProblem.CASH_NOT_COUNTED
        CloseStep.STOCK_COUNTED -> CloseProblem.STOCK_NOT_COUNTED
        CloseStep.UPLOADS_SENT -> CloseProblem.UPLOADS_WAITING
        CloseStep.SALES_MATCH_STOCK -> CloseProblem.SALES_STOCK_DISAGREE
    }

    /** True when the seller still has to confirm the exceptions before closing. */
    fun needsReview(checklist: TripCloseChecklist, policy: TripClosePolicy): Boolean =
        policy.exceptionsNeedReview && checklist.exceptions.isNotEmpty()

    fun normalizedNote(note: String?): String? = note?.trim()?.takeIf { it.isNotEmpty() }

    fun validNote(note: String?): Boolean = normalizedNote(note).let { it == null || it.length <= MAX_NOTE && it.none(Char::isISOControl) }

    /** The end reading is optional; when the start reading is known it may not be lower. */
    fun validOdometer(endKm: Double?, startKm: Double?): Boolean =
        endKm == null || endKm.isFinite() && endKm in 0.0..MAX_ODOMETER_KM && (startKm == null || endKm >= startKm)

    /**
     * Every rule in order: blockers first, then the request's own fields, then the review. Returns whether the
     * exceptions were confirmed by the seller.
     */
    fun authorize(checklist: TripCloseChecklist, policy: TripClosePolicy, request: TripCloseRequest, startKm: Double?): Boolean {
        if (!validId(request.closeId)) throw TripCloseRefused(CloseProblem.CLOSE_INVALID)
        checklist.blockers.firstOrNull()?.let { throw TripCloseRefused(problem(it.step)) }
        if (!validOdometer(request.endOdometerKm, startKm)) throw TripCloseRefused(CloseProblem.ODOMETER_INVALID)
        if (!validNote(request.note)) throw TripCloseRefused(CloseProblem.NOTE_INVALID)
        val confirmed = request.reviewCode != null && request.reviewCode == checklist.reviewCode
        if (needsReview(checklist, policy)) {
            if (request.reviewCode == null) throw TripCloseRefused(CloseProblem.REVIEW_REQUIRED)
            if (!confirmed) throw TripCloseRefused(CloseProblem.EXCEPTIONS_CHANGED)
        }
        return confirmed && checklist.exceptions.isNotEmpty()
    }
}
