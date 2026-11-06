package com.sunpride.van.pos

import com.sunpride.van.data.PaymentKind
import org.json.JSONArray
import org.json.JSONObject

/**
 * IP-HH2: a sale paid with cash plus ONE more tender (GCash, check, bank, or the customer's credit as the office allows).
 * [amountMinor] is what the other tender pays; cash pays the rest and is the only tender that gives change.
 */
data class SplitPayment(val methodCode: String, val amountMinor: Long, val reference: String? = null)

/** The two parts as they will be saved: [cash] carries the cash handed over and the change, [other] the second tender. */
data class QuotedSplit(val cash: QuotedPayment, val other: QuotedPayment) {
    init { require(cash.method.kind == PaymentKind.CASH && other.method.kind != PaymentKind.CASH) }
    val parts: List<QuotedPayment> get() = listOf(cash, other)
}

/** What the cashier sees while entering a split: the part due in cash, the balance still open and the change. */
data class SplitView(val totalMinor: Long, val otherMinor: Long, val cashDueMinor: Long, val cashHandedMinor: Long,
    val remainingMinor: Long, val changeMinor: Long) {
    val ready: Boolean get() = otherMinor in 1 until totalMinor && cashHandedMinor >= cashDueMinor
}

object SplitTenders {
    /** The other tender must be more than zero and leave something for cash. */
    fun partsValid(totalMinor: Long, otherMinor: Long): Boolean = totalMinor > 1 && otherMinor in 1 until totalMinor

    /** Remaining balance (live), cash due and change. Change comes from cash only: it is what cash handed over exceeds the cash due. */
    fun view(totalMinor: Long, otherMinor: Long, cashHandedMinor: Long): SplitView {
        val other = otherMinor.coerceIn(0, maxOf(0, totalMinor))
        val due = totalMinor - other
        return SplitView(totalMinor, other, due, cashHandedMinor, maxOf(0L, due - cashHandedMinor), maxOf(0L, cashHandedMinor - due))
    }

    /** The wire shape of a sale paid with cash plus one more tender: `payment` of `sale.record`. The server reads `payment.parts` (IP-INT3). */
    fun paymentJson(total: Long, split: QuotedSplit): JSONObject = JSONObject().put("split",true).put("method","split").put("kind","split")
        .put("status",split.other.state.wire).put("amountMinor",total.toString())
        .put("parts",JSONArray(split.parts.map { part -> JSONObject().put("method",part.method.code).put("kind",part.method.kind.wire).put("status",part.state.wire)
            .put("amountMinor",part.amountMinor.toString())
            .apply { part.tenderedMinor?.let { put("tenderedMinor",it.toString()).put("changeMinor",part.changeMinor.toString()) } }
            .apply { part.reference?.let { put("reference",it) } }.apply { part.dueDate?.let { put("dueDate",it) } } }))
}
