package com.sunpride.field.ui.today

import com.sunpride.field.storage.ProductiveCall
import com.sunpride.field.ui.TodayData
import com.sunpride.field.ui.VisitDisplay

/** One stop of today's route in Master Coverage Plan order (1-based [stop]). */
data class RouteStop(val stop: Int, val visit: VisitDisplay) {
    val done get() = visit.status == TodaySummary.STATUS_DONE
    val inProgress get() = visit.status == TodaySummary.STATUS_IN_PROGRESS
    val needsReview get() = visit.status == TodaySummary.STATUS_REVIEW
}

/**
 * Pure Today dashboard projection over the local cache and outbox.
 *
 * A call is a planned store of the day's route that was visited (client call, 2 Oct 2026). A finished call is
 * productive by the governed rule in [ProductiveCall] (any one listed activity recorded at the visit; a truck
 * seller's merchandising only with the "no sales due to inventory" marker), never by the End call outcome.
 * [rule] is the seller's position rule from the daily sales report; unknown means the stricter rule.
 */
data class TodaySummary(
    val stops: List<RouteStop>,
    val routeCode: String?,
    val rule: String? = null,
) {
    val planned get() = stops.size
    val done get() = stops.count { it.done }
    fun productive(stop: RouteStop): Boolean =
        stop.done && stop.visit.callFacts?.let { ProductiveCall.productive(it, rule) } == true
    val productive get() = stops.count { productive(it) }
    /** Whole percent of finished calls that were productive, rounded down like the server; null before the first call ends. */
    val productivePercent: Int? get() = if (done == 0) null else productive * 100 / done
    val progress: Float get() = if (planned == 0) 0f else done.toFloat() / planned
    /** The open call when there is one, else the first stop in plan order that is not finished. */
    val next: RouteStop? get() = stops.firstOrNull { it.inProgress } ?: stops.firstOrNull { !it.done }
    val allDone get() = planned > 0 && done == planned

    companion object {
        const val STATUS_DONE = "Done"
        const val STATUS_IN_PROGRESS = "In progress"
        const val STATUS_REVIEW = "Needs review"

        /** Same order the visit rules enforce: sequence, then wire list position, then input order. */
        fun of(data: TodayData): TodaySummary = TodaySummary(
            data.visits.withIndex().sortedBy { it.value.sequence ?: it.value.listPosition ?: it.index }
                .mapIndexed { index, item -> RouteStop(index + 1, item.value) },
            data.routeCode,
            data.sales.sales?.productiveCallRule,
        )
    }
}
