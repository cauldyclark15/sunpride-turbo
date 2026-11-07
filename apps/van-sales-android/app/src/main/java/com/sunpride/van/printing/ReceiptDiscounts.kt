package com.sunpride.van.printing

import com.sunpride.van.pos.QuotedSplit
import com.sunpride.van.selling.DiscountClaim
import com.sunpride.van.selling.LegalCart
import org.json.JSONArray
import org.json.JSONObject

/** IP-HH2: what a receipt says about a statutory discount and about a split payment; stored inside the frozen receipt's fiscal JSON. */
object ReceiptDiscounts {
    fun claimJson(claim: DiscountClaim, legal: LegalCart?): JSONObject = JSONObject().put("type", claim.type.wire).put("label", claim.type.label)
        .put("idNumber", claim.idNumber.trim()).put("holderName", claim.holderName.trim()).put("applied", legal?.applied ?: false)
        .put("privilegeDiscountMinor", (legal?.privilegeDiscount ?: 0L).toString()).put("vatRemovedMinor", (legal?.vatRemoved ?: 0L).toString())
        .apply { weeklyLimit(claim, legal)?.let { put("weeklyLimit", it) } }

    /**
     * IP-SCPWD-CAP: what the receipt says about the weekly limit, as this phone knew it when the sale was made ("best known").
     * Null when the phone knew of no limit for this card (an older bundle, a switched-off limit, or a type that has none).
     */
    fun weeklyLimit(claim: DiscountClaim, legal: LegalCart?): JSONObject? {
        val budget = claim.capBudget ?: legal?.budget ?: return null
        val applied = legal?.appliedGross ?: 0L
        return JSONObject().put("leftMinor", maxOf(0L, budget - applied).toString()).put("limited", legal != null && legal.eligibleGross > legal.appliedGross)
    }

    fun paymentsJson(split: QuotedSplit): JSONArray = JSONArray(split.parts.map { p ->
        JSONObject().put("label", p.method.label).put("kind", p.method.kind.wire).put("amountMinor", p.amountMinor.toString())
            .apply { p.tenderedMinor?.let { put("tenderedMinor", it.toString()).put("changeMinor", p.changeMinor.toString()) } }
            .apply { p.reference?.let { put("reference", it) } }
    })

    /** The discount lines for the receipt, in order: the amounts come from the claim, never from the printed total. */
    fun claimLines(fiscal: JSONObject?, money: (Long) -> String): List<Pair<String, String?>> {
        val claim = fiscal?.optJSONObject("discountClaim") ?: return emptyList()
        val label = claim.optString("label", "Discount")
        val discount = claim.optString("privilegeDiscountMinor", "0").toLongOrNull() ?: 0L
        val removed = claim.optString("vatRemovedMinor", "0").toLongOrNull() ?: 0L
        return buildList {
            if (claim.optBoolean("applied")) {
                add("$label discount" to "-" + money(discount))
                if (removed > 0) add("VAT removed" to money(removed))
            } else if (claim.optJSONObject("weeklyLimit")?.optString("leftMinor") == "0") add("$label: weekly limit reached, no discount" to null)
            else add("$label: promotion was better, no discount" to null)
            add("$label: ${claim.optString("holderName")}" to null)
            add("ID: ${claim.optString("idNumber")}" to null)
            claim.optJSONObject("weeklyLimit")?.optString("leftMinor")?.toLongOrNull()?.let { add("Weekly limit: ${money(it)} left" to null) }
        }
    }

    /** One `(label, amount, extra)` per tender of a split payment; empty for a one-tender sale. */
    fun paymentLines(fiscal: JSONObject?, money: (Long) -> String): List<Pair<String, String>> {
        val rows = fiscal?.optJSONArray("payments") ?: return emptyList()
        return (0 until rows.length()).flatMap { i ->
            val p = rows.getJSONObject(i)
            buildList {
                add(p.optString("label") to money(p.optString("amountMinor", "0").toLong()))
                if (p.has("tenderedMinor")) {
                    add("  Cash received" to money(p.optString("tenderedMinor", "0").toLong()))
                    add("  Change" to money(p.optString("changeMinor", "0").toLong()))
                }
                if (p.has("reference")) add("  Ref" to p.optString("reference"))
            }
        }
    }
}
