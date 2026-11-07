package com.sunpride.van.selling

import org.json.JSONArray
import org.json.JSONObject

/**
 * IP-HH2: the statutory discount (Senior / PWD / Solo parent / Athlete / Uniformed) worked out on the phone with the SAME
 * formulas as the server (`apps/api/src/domains/fiscal/privilege.js`, Itemcount BIR guide): prices are VAT-inclusive,
 *
 *   net        = round(gross / (1 + vat))        (half up)
 *   vatRemoved = gross - net
 *   discount   = round(net * rate)               20% senior / PWD / athlete, 10% solo parent / uniformed
 *   senior, PWD, solo parent, uniformed: VAT comes off, then the discount comes off the VAT-exclusive amount
 *   athlete: the 20% comes off the VAT-exclusive amount and the VAT stays
 *   exempt / zero-rated lines: nothing to remove, the discount is taken on the line amount
 *   promo and privilege never stack: the larger benefit wins, a tie goes to the promo
 *
 * Offline this is the only calculation; online the server preview (`fiscal/discount-claims/preview`) must agree with it, and the
 * server refuses a sale whose total differs. Everything is integer centavos.
 */
enum class PrivilegeType(val wire: String, val label: String, val rateBps: Int, val keepsVat: Boolean) {
    SENIOR("senior", "Senior citizen", 2000, false),
    PWD("pwd", "PWD", 2000, false),
    SOLO_PARENT("solo_parent", "Solo parent", 1000, false),
    ATHLETE("athlete", "National athlete or coach", 2000, true),
    UNIFORMED("uniformed", "Uniformed personnel", 1000, false);

    companion object { fun of(wire: String?): PrivilegeType? = entries.firstOrNull { it.wire == wire } }
}

/** What the cashier typed: the type, the card's ID number and the name on it; [eligibleProductIds] null = every line. */
data class DiscountClaim(val type: PrivilegeType, val idNumber: String, val holderName: String, val eligibleProductIds: Set<String>? = null,
    /** IP-SCPWD-CAP: how much of the purchase this phone let carry the discount (the weekly limit it knew about); null = it knew of no limit. */
    val capBudget: Long? = null) {
    fun json(privilegeDiscountKey: String, vatRemovedKey: String, totals: LegalCart?): JSONObject = JSONObject()
        .put("type", type.wire).put("idNumber", idNumber.trim()).put("holderName", holderName.trim())
        .apply { eligibleProductIds?.let { put("eligibleProductIds", JSONArray(it.sorted())) } }
        .apply { totals?.let { put(privilegeDiscountKey, it.privilegeDiscount.toString()).put(vatRemovedKey, it.vatRemoved.toString()) } }
        // Opt-in wire field: an older server ignores it, and an older phone never sends it (the server then treats the sale as uncapped).
        .apply { capBudget?.let { b -> put("capBasis", JSONObject().put("budgetCentavos", b.toString()).apply { totals?.let { put("appliedCentavos", it.appliedGross.toString()) } }) } }
}

object ClaimRules {
    private val idPattern = Regex("^[A-Za-z0-9][A-Za-z0-9 \\-/.]{2,39}$")
    /** Plain words for what is wrong with the claim, or null when it can be sent. Same checks as the server's `normalizeClaim`. */
    fun problem(claim: DiscountClaim): String? {
        val id = claim.idNumber.trim(); val name = claim.holderName.trim()
        return when {
            !idPattern.matches(id) -> "Enter the ${claim.type.label.lowercase()} ID number exactly as printed on the card (3 to 40 letters or digits)."
            name.length < 2 || name.length > 120 || name.any { it.isISOControl() } -> "Enter the name of the person on the ID."
            claim.eligibleProductIds?.isEmpty() == true -> "Choose at least one item that gets the discount."
            else -> null
        }
    }
    fun typeProblem(id: String, name: String, type: PrivilegeType?): String? = when {
        type == null -> "Choose the discount type."
        else -> problem(DiscountClaim(type, id, name))
    }
}

/** How one product is taxed, from the office's tax set-up on this phone. [vatBps] is only used for a VATable line. */
data class TaxFact(val treatment: String, val vatBps: Int) {
    val known: Boolean get() = treatment == "vatable" && vatBps in 1..10000 || treatment == "exempt" || treatment == "zero_rated"
}

/** One line as the discount sees it: [gross] before any discount, [promoDiscount] the promotion part only. */
data class LegalInput(val productId: String, val gross: Long, val promoDiscount: Long, val tax: TaxFact?)

data class LegalLine(
    val gross: Long, val vatable: Long, val vat: Long, val vatExempt: Long, val zeroRated: Long,
    val privilegeDiscount: Long, val promoDiscount: Long, val net: Long, val vatRemoved: Long, val privilegeType: PrivilegeType?,
)

/** [appliedGross] = the regular price of the part that got the privilege discount (counts against the weekly limit); [budget] = the limit the phone worked with (null = none). */
data class LegalCart(val lines: List<LegalLine>, val gross: Long, val promoDiscount: Long, val privilegeDiscount: Long,
    val vatRemoved: Long, val total: Long, val applied: Boolean, val appliedGross: Long = 0, val eligibleGross: Long = 0, val budget: Long? = null)

object Privilege {
    /** Half-up integer division for non-negative numbers. */
    private fun divRound(n: Long, d: Long): Long = (2 * n + d) / (2 * d)

    /** One line, quantity 1 at its gross price (the server does the same). [type] null = this line gets no privilege. */
    fun line(gross: Long, promoAsked: Long, tax: TaxFact, type: PrivilegeType?): LegalLine {
        require(gross >= 0 && promoAsked >= 0 && tax.known)
        val promo = minOf(promoAsked, gross)
        val taxable = tax.treatment == "vatable"
        val rate = 10000L + if (taxable) tax.vatBps else 0
        var priv = 0L; var removed = 0L; var netEx = gross
        if (type != null) {
            if (taxable) { netEx = divRound(gross * 10000, rate); removed = gross - netEx }
            priv = divRound(netEx * type.rateBps, 10000)
        }
        val keeps = type?.keepsVat == true
        val benefit = if (type != null) priv + (if (keeps) 0 else removed) else 0
        val wins = type != null && benefit > promo && gross - benefit > 0
        var vatable = 0L; var vat = 0L; var exempt = 0L; var zero = 0L
        val pay: Long; var privOut = 0L; var promoOut = 0L; var removedOut = 0L
        if (wins) {
            privOut = priv
            if (taxable && keeps) { vatable = netEx; vat = removed; pay = gross - priv }
            else if (taxable) { exempt = netEx; removedOut = removed; pay = netEx - priv }
            else { if (tax.treatment == "exempt") exempt = gross else zero = gross; pay = gross - priv }
        } else {
            promoOut = promo; pay = gross - promo
            if (taxable) { vatable = divRound(pay * 10000, rate); vat = pay - vatable }
            else if (tax.treatment == "exempt") exempt = pay else zero = pay
        }
        return LegalLine(gross, vatable, vat, exempt, zero, privOut, promoOut, pay, removedOut, if (wins) type else null)
    }

    /** A line with no gross (a free gift) carries no tax and no privilege. */
    private fun free(promo: Long) = LegalLine(0, 0, 0, 0, 0, 0, promo, 0, 0, null)

    /** Add the two halves of a line the weekly limit split (same arithmetic as the server's `merge`). */
    private fun merge(a: LegalLine, b: LegalLine) = LegalLine(a.gross + b.gross, a.vatable + b.vatable, a.vat + b.vat, a.vatExempt + b.vatExempt,
        a.zeroRated + b.zeroRated, a.privilegeDiscount + b.privilegeDiscount, a.promoDiscount + b.promoDiscount, a.net + b.net,
        a.vatRemoved + b.vatRemoved, a.privilegeType)

    /** Half-up integer a*b/d for non-negative numbers (BigInteger: gross*take can pass 2^63 only in absurd carts, but never wrap). */
    private fun mulDivRound(a: Long, b: Long, d: Long): Long {
        val n = java.math.BigInteger.valueOf(a).multiply(java.math.BigInteger.valueOf(b))
        val dd = java.math.BigInteger.valueOf(d)
        val two = java.math.BigInteger.valueOf(2) // BigInteger.TWO needs API 33; the phones run API 29+
        return n.multiply(two).add(dd).divide(dd.multiply(two)).toLong()
    }

    /**
     * The whole cart. Returns the plain-words problem as a [Result.failure] message when a line has no tax set-up (never guessed).
     * [claim] null = no privilege: the same lines, promo only (used for the server preview and the receipt).
     *
     * IP-SCPWD-CAP: [budget] is how many centavos of the regular price may carry the discount (the weekly limit left, as this phone
     * knows it); null = no limit. Lines are taken in order. A line that does not fit whole is split: the part that fits gets the
     * discount, the rest is a plain line (its promotion share pro rata, half up). Mirrors `computeWithBudget` in
     * `apps/api/src/domains/fiscal/privilege-cap.js`; both are held to `privilege-cap-vectors.json`.
     */
    fun cart(lines: List<LegalInput>, claim: DiscountClaim?, budget: Long? = null): Result<LegalCart> = runCatching {
        require(budget == null || budget >= 0)
        var left = budget ?: Long.MAX_VALUE
        var appliedGross = 0L; var eligibleGross = 0L
        val out = lines.map { l ->
            if (l.gross == 0L) free(l.promoDiscount)
            else {
                val tax = l.tax?.takeIf { it.known } ?: throw IllegalStateException(NO_TAX_SETUP)
                val takes = claim != null && (claim.eligibleProductIds?.contains(l.productId) ?: true)
                val full = line(l.gross, l.promoDiscount, tax, if (takes) claim?.type else null)
                if (full.privilegeType == null) full
                else {
                    eligibleGross += l.gross
                    val take = minOf(l.gross, left)
                    when {
                        take >= l.gross -> { left -= take; appliedGross += take; full }
                        take <= 0L -> line(l.gross, l.promoDiscount, tax, null)
                        else -> {
                            val promoA = mulDivRound(l.promoDiscount, take, l.gross)
                            val a = line(take, promoA, tax, claim?.type)
                            val b = line(l.gross - take, l.promoDiscount - promoA, tax, null)
                            if (a.privilegeType != null) { left -= take; appliedGross += take }
                            merge(a, b)
                        }
                    }
                }
            }
        }
        LegalCart(out, out.sumOf { it.gross }, out.sumOf { it.promoDiscount }, out.sumOf { it.privilegeDiscount }, out.sumOf { it.vatRemoved },
            out.sumOf { it.net }, out.any { it.privilegeType != null }, appliedGross, eligibleGross, budget)
    }

    const val NO_TAX_SETUP = "Some items have no tax set-up on this phone, so the discount cannot be worked out. Ask the office to finish the price and tax set-up, then sync."
}
