package com.sunpride.field.storage

import com.sunpride.field.ui.diagnosticvisit.LocationAssessment
import com.sunpride.field.ui.diagnosticvisit.LocationCapture
import com.sunpride.field.ui.diagnosticvisit.LocationFix
import com.sunpride.field.ui.diagnosticvisit.UnavailableReason
import org.json.JSONObject

/**
 * AND-017: what the salesperson confirms before End, and the visit's result once End is queued.
 * [recorded]/[officeReview] are activity kinds; [officeReview] are required forms this phone could not
 * capture, which the server records as missing (it never refuses a queued End).
 */
data class EndReview(val outcome: String, val reasonCode: String?, val recorded: List<String>,
    val officeReview: List<String>, val missing: List<String>, val minutes: Long?)

/** The immutable result of a queued End, read back from the outbox. */
data class VisitResult(val outcome: String, val reasonCode: String?, val recorded: List<String>,
    val officeReview: List<String>, val minutes: Long, val location: String, val locationReview: Boolean,
    val sync: String)

object VisitCompletion {
    private fun payload(row: IntentRow) = JSONObject(row.serializedOperation).getJSONObject("payload")
    private fun usable(state: String) = state in setOf("pending", "sending", "done")
    private fun ownRows(clientVisitId: String, rows: List<Pair<IntentRow, String>>) =
        rows.filter { it.first.clientVisitId == clientVisitId }

    fun outcomeLabel(outcome: String) = when (outcome) {
        "completed" -> "Completed"; "nonproductive" -> "Not productive"; else -> "Unknown"
    }

    /**
     * Store guard: once a call's End is queued, the visit is final on this phone. Nothing may be added to it
     * (the server would refuse it as an invalid transition and hold the outbox behind it). A server-rejected
     * End no longer closes the call, so the person can still finish it.
     */
    fun requireOpenForActivity(intent: IntentRow, rows: List<Pair<IntentRow, String>>) {
        if (intent.kind != "visit.activity") return
        if (VisitCallRules.closed(ownRows(intent.clientVisitId, rows)))
            throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
    }

    /** What End will record, for the confirmation step. Throws the same rule failures End would. */
    fun review(clientVisitId: String, outcome: String?, reasonCode: String?, rules: List<ActivityRule>,
        rows: List<Pair<IntentRow, String>>, sheet: CallSheet?, now: Long): EndReview {
        val end = JSONObject().put("outcome", outcome ?: JSONObject.NULL).put("reasonCode", reasonCode ?: JSONObject.NULL)
        VisitCallRules.requireEnd(clientVisitId, end, rows)
        ActivityRules.requireForEnd(clientVisitId, outcome, rules, rows, sheet)
        val checklist = ActivityRules.checklist(rules, ActivityRules.intentsOf(clientVisitId, rows),
            ActivityRules.recordedKinds(clientVisitId, rows)) { ActivityRules.capturable(it, sheet) }
        val start = ownRows(clientVisitId, rows).firstOrNull { it.first.kind == "visit.checkIn" && usable(it.second) }
        val minutes = start?.let { (now - payload(it.first).getLong("deviceTime")).coerceAtLeast(0) / 60_000 }
        return EndReview(outcome!!, reasonCode?.trim()?.takeIf { outcome == "nonproductive" && it.isNotEmpty() },
            recordedInOrder(clientVisitId, rows),
            checklist.filter { it.required && it.status == ActivityRequirement.Status.UNAVAILABLE }.map { it.kind },
            ActivityRules.missing(checklist), minutes)
    }

    /** The queued (or accepted) End of this call, as the person's final record; null while the call is open. */
    fun result(clientVisitId: String, rules: List<ActivityRule>, rows: List<Pair<IntentRow, String>>,
        sheet: CallSheet?): VisitResult? {
        val own = ownRows(clientVisitId, rows)
        val start = own.firstOrNull { it.first.kind == "visit.checkIn" && usable(it.second) } ?: return null
        val (end, state) = own.lastOrNull { it.first.kind == "visit.checkOut" && usable(it.second) } ?: return null
        val p = payload(end)
        val outcome = p.optString("outcome")
        val reason = if (p.isNull("reasonCode")) null else p.optString("reasonCode").takeIf { it.isNotBlank() }
        val endedAt = p.getLong("deviceTime")
        // The End fix is assessed as of the moment End was recorded, the same view the person saw then.
        val fix = LocationFix.fromJson(if (p.isNull("location")) null else p.optJSONObject("location"))
        val notice = LocationAssessment.notice(fix?.let { LocationCapture.Captured(it) }
            ?: LocationCapture.Unavailable(UnavailableReason.NO_FIX), endedAt)
        val officeReview = if (outcome != "completed") emptyList() else ActivityRules.checklist(rules,
            ActivityRules.intentsOf(clientVisitId, rows), ActivityRules.recordedKinds(clientVisitId, rows)) {
            ActivityRules.capturable(it, sheet)
        }.filter { it.required && it.status != ActivityRequirement.Status.DONE }.map { it.kind }
        return VisitResult(outcome, reason, recordedInOrder(clientVisitId, rows), officeReview,
            (endedAt - payload(start.first).getLong("deviceTime")).coerceAtLeast(0) / 60_000,
            if (fix == null) "End location unavailable · supervisor will review" else notice.text.replaceFirst("Location", "End location"),
            notice.review, when (state) { "done" -> "Accepted"; else -> "Waiting to send" })
    }

    private fun recordedInOrder(clientVisitId: String, rows: List<Pair<IntentRow, String>>): List<String> =
        ownRows(clientVisitId, rows).filter { it.first.kind == "visit.activity" && usable(it.second) }
            .mapNotNull { payload(it.first).optJSONObject("activity")?.optString("kind")?.takeIf { k -> k.isNotBlank() } }
            .distinct()
}
