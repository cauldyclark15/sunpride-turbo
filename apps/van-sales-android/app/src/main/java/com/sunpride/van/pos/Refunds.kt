package com.sunpride.van.pos

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * IP-REFUND: refund part of a sale. This file is the phone's copy of `apps/api/src/domains/fiscal/refund-math.js`;
 * `apps/api/test/fixtures/refund-math-cases.json` holds cases both sides must answer identically (RefundMathTest here,
 * refund-math.test.js there), so the slip the phone prints always agrees with the credit memo the office freezes.
 *
 * All money is whole centavos. Every amount of a refunded line is the line's frozen amount times the refunded share of
 * that line, rounded half-up and CUMULATIVELY, so refunding a line in several parts adds up to exactly the original.
 */
class RefundRefused(message: String) : IllegalStateException(message)

/** A reason the cashier can pick; [destination] says where the goods go: `sellable` stock or `damaged` stock. */
data class RefundReason(val code: String, val label: String, val destination: String, val requiresNote: Boolean) {
    val damaged: Boolean get() = destination == "damaged"
}

/** A refund the office already knows about (so "already refunded" is right on a phone that was offline for a while). */
data class MadeRefund(val id: String, val saleId: String, val creditNumber: String, val totalMinor: Long,
    val lines: Map<Int, Long>, val tenders: Map<String, Long>)

/** What the office sends a phone that asked for refunds (`policy.refunds` on the van, `refunds` on the till bundle). */
data class RefundPolicy(val supervisorOverMinor: Long, val reasons: List<RefundReason>, val approvalKey: String?, val made: List<MadeRefund>) {
    fun reason(code: String?): RefundReason? = reasons.firstOrNull { it.code == code }
    companion object {
        fun decode(o: JSONObject?): RefundPolicy? {
            if (o == null) return null
            val reasons = o.getJSONArray("reasons").let { a ->
                (0 until a.length()).map { a.getJSONObject(it) }.map {
                    RefundReason(it.getString("code"), it.getString("label"), it.getString("destination").also { d -> require(d == "sellable" || d == "damaged") },
                        it.optBoolean("requiresNote", false))
                }
            }
            require(reasons.isNotEmpty() && reasons.size <= 40 && reasons.map { it.code }.distinct().size == reasons.size)
            val made = (o.optJSONArray("made") ?: JSONArray()).let { a ->
                (0 until a.length()).map { a.getJSONObject(it) }.map { m ->
                    MadeRefund(m.getString("id"), m.getString("saleId"), m.optString("creditNumber"), m.getString("totalMinor").toLong(),
                        (m.optJSONArray("lines") ?: JSONArray()).let { l -> (0 until l.length()).associate { i -> l.getJSONObject(i).let { x -> x.getInt("lineIndex") to x.getString("quantityBase").toLong() } } },
                        (m.optJSONArray("tenders") ?: JSONArray()).let { t -> (0 until t.length()).map { i -> t.getJSONObject(i) }.groupBy { x -> x.getString("method") }
                            .mapValues { (_, v) -> v.sumOf { x -> x.getString("amountCentavos").toLong() } } })
                }
            }
            return RefundPolicy(o.getString("supervisorOverMinor").toLong(), reasons, if (o.isNull("approvalKey")) null else o.optString("approvalKey").takeIf { it.isNotEmpty() }, made)
        }
    }
}

/** One line of the original receipt, as the refund maths reads it. */
data class SoldLine(val index: Int, val productId: String, val name: String, val uom: String?, val quantityBase: Long, val payableMinor: Long,
    val grossMinor: Long, val promoMinor: Long)

data class RefundedLine(val line: SoldLine, val quantityBase: Long, val amountMinor: Long, val vatMinor: Long, val bucket: String,
    val grossMinor: Long, val promoMinor: Long, val privilegeDiscountMinor: Long, val vatRemovedMinor: Long,
    /** Pieces of this line still not refunded after this refund. */
    val remainingBase: Long)

data class RefundPlan(val totalMinor: Long, val lines: List<RefundedLine>, val vatableMinor: Long, val vatMinor: Long, val vatExemptMinor: Long,
    val zeroRatedMinor: Long, val privilegeDiscountMinor: Long)

/** Where the refund money goes: one entry per original payment method. */
data class RefundTender(val method: String, val label: String, val amountMinor: Long)

object RefundMath {
    private fun big(v: Long) = BigInteger.valueOf(v)
    private fun divRound(n: BigInteger, d: BigInteger): BigInteger = n.multiply(BigInteger.TWO).add(d).divide(d.multiply(BigInteger.TWO))
    private fun money(o: JSONObject, key: String): Long = if (!o.has(key) || o.isNull(key)) 0L else o.get(key).toString().toLong()

    /** The refunded part of [amount] when [before] of [sold] units were already refunded and [now] more are. */
    fun share(amount: Long, before: Long, now: Long, sold: Long): Long {
        if (sold <= 0L || amount == 0L) return 0L
        val a = big(amount)
        return divRound(a.multiply(big(before + now)), big(sold)).subtract(divRound(a.multiply(big(before)), big(sold))).longValueExact()
    }

    /** Store and van receipts hold lines in two shapes; this reads both (same rule as `saleLines` on the office side). */
    fun saleLines(receipt: JSONObject): List<SoldLine> {
        val lines = receipt.optJSONArray("lines")
        if (lines == null || lines.length() == 0) throw RefundRefused("This receipt has no lines to refund")
        return (0 until lines.length()).map { i ->
            val l = lines.getJSONObject(i)
            val van = l.has("totalMinor") && !l.has("lineTotalCentavos")
            val payable = money(l, if (van) "totalMinor" else "lineTotalCentavos")
            SoldLine(i, l.getString("productId"),
                (if (van) l.optString("name").ifEmpty { l.optString("code") } else l.optString("description").ifEmpty { l.optString("productCode") }).ifEmpty { "Item" },
                (if (van) l.optString("uomCode") else l.optString("uom")).ifEmpty { null },
                money(l, "quantityBase"), payable,
                if (van) money(l, "grossMinor") else payable + money(l, "discountCentavos"),
                if (van) money(l, "discountMinor") else if (l.has("promoDiscountCentavos")) money(l, "promoDiscountCentavos") else money(l, "discountCentavos"))
        }
    }

    /** Which tax-snapshot line belongs to each receipt line (the snapshot skips zero-gross lines on some sales). */
    fun taxLinesFor(lines: List<SoldLine>, tax: JSONObject?): List<JSONObject?> {
        val t = tax?.optJSONArray("lines")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) } } ?: emptyList()
        if (t.size == lines.size) return t
        val nonZero = lines.filter { it.grossMinor != 0L }
        if (t.size == nonZero.size) {
            var k = 0
            return lines.map { if (it.grossMinor == 0L) null else t[k++] }
        }
        return lines.map { null }
    }

    /** [receipt] is the frozen original, [prior] the base quantity already refunded per receipt line index, [picks] line index -> base quantity now. */
    fun plan(receipt: JSONObject, prior: Map<Int, Long>, picks: Map<Int, Long>): RefundPlan {
        val lines = saleLines(receipt)
        if (picks.isEmpty() || picks.size > 100) throw RefundRefused("Choose at least one item to refund")
        val saleTax = receipt.optJSONObject("tax") ?: JSONObject()
        val taxLines = taxLinesFor(lines, receipt.optJSONObject("tax"))
        val saleTotal = lines.sumOf { it.payableMinor }
        var total = 0L; var vatable = 0L; var vat = 0L; var exempt = 0L; var zero = 0L; var privilege = 0L
        val out = ArrayList<RefundedLine>()
        for ((index, q) in picks.toSortedMap()) {
            val line = lines.getOrNull(index) ?: throw RefundRefused("That item is not on the original receipt")
            if (q <= 0L) throw RefundRefused("Refund at least one piece of each chosen item")
            val done = prior[index] ?: 0L
            if (done + q > line.quantityBase) throw RefundRefused(if (done > 0L) "That is more than was sold and not yet refunded" else "That is more than was sold")
            val amount = share(line.payableMinor, done, q, line.quantityBase)
            val tl = taxLines[index]
            var lineVat = 0L; var bucket = "vatable"; var removed = 0L; var linePriv = 0L
            if (tl != null) {
                lineVat = share(money(tl, "vatMinor"), done, q, line.quantityBase)
                removed = share(money(tl, "vatRemovedMinor"), done, q, line.quantityBase)
                linePriv = share(money(tl, "privilegeDiscountMinor"), done, q, line.quantityBase)
                val removesVat = !tl.isNull("privilegeType") && tl.optString("privilegeType").isNotEmpty() && money(tl, "vatRemovedMinor") > 0L
                val treatment = tl.optString("treatment")
                bucket = if (treatment == "zero_rated") "zero" else if (treatment == "exempt" || removesVat) "exempt" else "vatable"
            } else if (saleTotal > 0L) {
                lineVat = divRound(big(amount).multiply(big(money(saleTax, "vatMinor"))), big(saleTotal)).longValueExact()
                bucket = if (money(saleTax, "vatableSalesMinor") > 0L) "vatable" else if (money(saleTax, "zeroRatedMinor") > 0L) "zero" else "exempt"
            }
            var bucketAmount = if (tl != null && tl.has("netMinor") && !tl.isNull("netMinor"))
                share(money(tl, "netMinor") + money(tl, "vatMinor"), done, q, line.quantityBase) else amount + linePriv
            if (bucket != "vatable") lineVat = 0L
            if (lineVat > bucketAmount) lineVat = bucketAmount
            val lineGross = share(line.grossMinor, done, q, line.quantityBase)
            val linePromo = share(line.promoMinor, done, q, line.quantityBase)
            when (bucket) {
                "vatable" -> { vatable += bucketAmount - lineVat; vat += lineVat }
                "exempt" -> exempt += bucketAmount
                else -> zero += bucketAmount
            }
            total += amount; privilege += linePriv
            out.add(RefundedLine(line, q, amount, lineVat, bucket, lineGross, linePromo, linePriv, removed, line.quantityBase - done - q))
        }
        return RefundPlan(total, out, vatable, vat, exempt, zero, privilege)
    }

    /** Cash first (it leaves the drawer), then the other methods in the order the sale took them; never more than a method took less what earlier refunds already returned. */
    fun tenders(original: List<RefundTender>, refunded: Map<String, Long>, total: Long): List<RefundTender> {
        val ordered = original.filter { it.method == "cash" } + original.filter { it.method != "cash" }
        var left = total
        val out = ArrayList<RefundTender>()
        for (t in ordered) {
            if (left <= 0L) break
            val room = t.amountMinor - (refunded[t.method] ?: 0L)
            if (room <= 0L) continue
            val give = minOf(room, left)
            out.add(RefundTender(t.method, t.label, give)); left -= give
        }
        if (left > 0L) throw RefundRefused("The customer paid less than this refund by those methods")
        return out
    }

    /** A refund above the office's amount needs a supervisor. */
    fun needsSupervisor(totalMinor: Long, overMinor: Long): Boolean = totalMinor > overMinor

    /** Pieces of each receipt line already refunded: what the office told this phone plus refunds saved here and not yet sent. */
    fun refundedSoFar(saleId: String, made: List<MadeRefund>, pending: List<Map<Int, Long>>): Map<Int, Long> {
        val out = HashMap<Int, Long>()
        made.filter { it.saleId == saleId }.forEach { m -> m.lines.forEach { (i, q) -> out[i] = (out[i] ?: 0L) + q } }
        pending.forEach { p -> p.forEach { (i, q) -> out[i] = (out[i] ?: 0L) + q } }
        return out
    }
}

/** The 8-digit code a supervisor reads out for ONE refund (receipt, amount, reason and which refund of the receipt it is). */
object RefundApprovalCodes {
    fun code(keyB64url: String, tripId: String, receiptNumber: String, totalMinor: Long, reasonCode: String, refundNumber: Int): String {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(keyB64url))
        val key = Base64.getUrlDecoder().decode(keyB64url)
        require(key.size == 32)
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
            .doFinal("REFUND|v1|$tripId|$receiptNumber|$totalMinor|$reasonCode|$refundNumber".toByteArray(Charsets.UTF_8))
        val o = mac[31].toInt() and 0x0f
        val bin = ((mac[o].toInt() and 0x7f) shl 24) or ((mac[o + 1].toInt() and 0xff) shl 16) or ((mac[o + 2].toInt() and 0xff) shl 8) or (mac[o + 3].toInt() and 0xff)
        return (bin % 100_000_000).toString().padStart(8, '0')
    }
    fun verify(keyB64url: String, tripId: String, receiptNumber: String, totalMinor: Long, reasonCode: String, refundNumber: Int, input: String): Boolean {
        val normalized = VoidApprovalCodes.normalize(input) ?: return false
        return MessageDigest.isEqual(code(keyB64url, tripId, receiptNumber, totalMinor, reasonCode, refundNumber).toByteArray(Charsets.UTF_8), normalized.toByteArray(Charsets.UTF_8))
    }
}

/** What the refund screen needs from the cashier before Confirm is allowed (plain words), or null. */
object RefundForm {
    fun problem(picks: Map<Int, Long>, reason: RefundReason?, note: String, needsApproval: Boolean, approved: Boolean): String? = when {
        picks.isEmpty() -> "Choose what the customer is returning."
        reason == null -> "Choose why."
        reason.requiresNote && note.trim().length < 3 -> "Write why in a few words."
        needsApproval && !approved -> "A supervisor has to approve this refund."
        else -> null
    }
}
