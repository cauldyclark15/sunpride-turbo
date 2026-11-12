package com.sunpride.van.pos

import org.json.JSONArray

/**
 * r6van3: the office's decision on a return held for its approval (F-113 pickup review on /van-trips), as the van
 * bundle carries it (`policy.pickupDecisions`, opt-in `params.pickupDecisions`). The goods were never on the truck,
 * so no decision moves truck stock on this phone; it only tells the seller what the office did.
 */
data class PickupDecision(val returnId: String, val decision: String, val reason: String, val decidedAt: Long) {
    /** The office checked that the goods were thrown away at the store (or otherwise closed the return as asked). */
    val approved: Boolean get() = decision != RETURNED_TO_OUTLET
    companion object {
        const val DISPOSAL_VERIFIED = "disposal_verified"
        const val RETURNED_TO_OUTLET = "returned_to_outlet"
        const val WAREHOUSE_RECEIVED = "warehouse_received"
        const val CREDIT_REQUESTED = "credit_requested"
        private val KINDS = setOf(DISPOSAL_VERIFIED, RETURNED_TO_OUTLET, WAREHOUSE_RECEIVED, CREDIT_REQUESTED)

        /** Lenient: a missing block is null (older server); a malformed entry is skipped, never a failed bootstrap. */
        fun decode(a: JSONArray?): Map<String, PickupDecision>? = a?.let {
            (0 until minOf(it.length(), 500)).mapNotNull { i -> runCatching {
                val o = it.getJSONObject(i)
                PickupDecision(o.getString("returnId"), o.getString("decision").also { k -> require(k in KINDS) },
                    o.optString("reason", "").trim().take(300), o.optLong("decidedAt", 0L))
            }.getOrNull() }.associateBy { d -> d.returnId }
        }

        /** Heading on the saved-return screen. */
        fun title(d: PickupDecision?): String = when (d?.decision) {
            null -> "Waiting for office approval"
            DISPOSAL_VERIFIED -> "Office verified the disposal"
            RETURNED_TO_OUTLET -> "Office rejected the return"
            WAREHOUSE_RECEIVED -> "Office received the goods at the warehouse"
            else -> "Office requested credit for this return"
        }

        /** The office's reason and what it means for the truck and the customer. */
        fun detail(d: PickupDecision): String {
            val reason = d.reason.ifBlank { null }?.let { "Reason: $it" }
            val effect = if (d.decision == RETURNED_TO_OUTLET)
                "The goods stay with the customer. Nothing was added to the truck stock and no refund is made."
            else "No truck stock changes on this phone."
            return listOfNotNull(reason, effect).joinToString("\n")
        }
    }
}
