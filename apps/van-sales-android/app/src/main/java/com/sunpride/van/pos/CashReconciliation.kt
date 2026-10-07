package com.sunpride.van.pos

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.VanPolicy
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * VAN-022 end-of-trip cash reconciliation. Pure rules shared by the Count cash screen and
 * `CashReconciliationStore.commit`, which runs them again inside the Room transaction that saves the count.
 *
 * Expected cash = the cash payment of every sale saved on this phone for the trip that was not voided (cash
 * sales keep the sale total; change went back to the customer). Check, e-wallet, bank and credit payments are
 * listed beside it but never expected in the cash bag. The seller counts bills and coins; any difference needs
 * a reason, and a difference above the office tolerance also needs a supervisor's 8-digit code bound to
 * (trip, expected, counted, reason), checked offline with the trip key from the bootstrap.
 */
data class CashVarianceReason(val code: String, val label: String)
object CashVarianceReasons {
    val ALL = listOf(
        CashVarianceReason("counting_error","Counting error"), CashVarianceReason("change_error","Wrong change given"),
        CashVarianceReason("customer_short_paid","Customer paid short"), CashVarianceReason("customer_overpaid","Customer overpaid"),
        CashVarianceReason("lost_or_stolen","Cash lost or stolen"), CashVarianceReason("counterfeit","Fake bill or coin"),
        CashVarianceReason("other","Other (explain)"))
    /** The office's reasons in its order; a policy cached before VAN-022 offers every known reason. */
    fun offered(policy: VanPolicy?): List<CashVarianceReason> = policy?.cashReconciliation?.reasons
        ?.mapNotNull { code -> ALL.firstOrNull { it.code == code } } ?: ALL
    fun label(code: String): String = ALL.firstOrNull { it.code == code }?.label ?: code
}

/** One bill or coin value in centavos. */
data class Denomination(val minor: Long, val label: String)
object CashDenominations {
    /** Philippine bills and coins in circulation, largest first. The ₱20 bill and coin share one row. */
    val PHP = listOf(Denomination(100_000,"₱1,000"), Denomination(50_000,"₱500"), Denomination(20_000,"₱200"),
        Denomination(10_000,"₱100"), Denomination(5_000,"₱50"), Denomination(2_000,"₱20"), Denomination(1_000,"₱10"),
        Denomination(500,"₱5"), Denomination(100,"₱1"), Denomination(25,"25¢"), Denomination(5,"5¢"), Denomination(1,"1¢"))
    /** At most this many of one bill or coin; far above any van day, small enough that no total can overflow. */
    const val MAX_PIECES = 100_000L
}

/** One sale's payment as frozen in the sale when it was saved. */
data class TripPayment(val saleId: String, val receiptNumber: String, val methodCode: String, val methodLabel: String,
    val kind: PaymentKind, val amountMinor: Long, val currency: String, val voided: Boolean)
/** Sales paid by one method that does not go in the cash bag (check, e-wallet, bank, credit). */
data class MethodTotal(val code: String, val label: String, val kind: PaymentKind, val count: Int, val amountMinor: Long)
/** [expectedMinor] is the cash the seller should hand in; [voidedSales] were left out. */
data class CashExpectation(val currency: String, val expectedMinor: Long, val cashSales: Int, val voidedSales: Int,
    val others: List<MethodTotal>)

enum class CashProblem { NOT_ON_ROUTE, HELD, ALREADY_COUNTED, EXPECTED_CHANGED, COUNT_INVALID, MIXED_CURRENCY,
    REASON_REQUIRED, NOTE_REQUIRED, NOTE_INVALID, APPROVAL_UNAVAILABLE, CODE_REQUIRED, CODE_WRONG }
class CashRefused(val problem: CashProblem) : IllegalStateException(problem.name)

/** What the seller saves. [counts] = pieces per denomination (centavos → pieces); [expectedMinor] is what the screen showed. */
data class CashCountRequest(val reconciliationId: String, val counts: Map<Long,Long>, val reasonCode: String?, val note: String?,
    val approvalCode: String?, val expectedMinor: Long)
/** [method] is `none` (within tolerance or no difference) or `supervisor_code`. */
data class CashAuthorization(val reasonCode: String?, val note: String?, val method: String, val code: String?)
data class CashCountResult(val reconciliationId: String, val tripNumber: String, val currency: String, val expectedMinor: Long,
    val declaredMinor: Long, val varianceMinor: Long, val reasonCode: String?, val note: String?, val approved: Boolean,
    val counts: Map<Long,Long>, val createdAt: Long, val replay: Boolean = false)

object CashReconciliationRules {
    private val uuidV4 = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    fun newReconciliationId(): String = UUID.randomUUID().toString()
    fun validId(id: String): Boolean = uuidV4.matches(id)

    /** Adds up the trip's payments. All sales on a van are in one currency; mixed currencies cannot be counted. */
    fun expectation(payments: List<TripPayment>): CashExpectation {
        val currencies = payments.map { it.currency }.toSet()
        if (currencies.size > 1) throw CashRefused(CashProblem.MIXED_CURRENCY)
        val live = payments.filterNot { it.voided }
        val cash = live.filter { it.kind == PaymentKind.CASH }
        val others = live.filter { it.kind != PaymentKind.CASH }.groupBy { it.methodCode }.map { (code, rows) ->
            MethodTotal(code, rows.first().methodLabel, rows.first().kind, rows.size, rows.fold(0L) { a, r -> Math.addExact(a, r.amountMinor) })
        }.sortedWith(compareBy<MethodTotal> { it.kind != PaymentKind.OTHER }.thenBy { it.label })
        return CashExpectation(currencies.singleOrNull() ?: "PHP", cash.fold(0L) { a, r -> Math.addExact(a, r.amountMinor) },
            cash.size, payments.count { it.voided }, others)
    }

    /** Total counted in centavos, or null when a value is not a known denomination or a count is out of range. */
    fun declared(counts: Map<Long,Long>): Long? {
        val known = CashDenominations.PHP.map { it.minor }.toSet()
        if (counts.keys.any { it !in known } || counts.values.any { it !in 0L..CashDenominations.MAX_PIECES }) return null
        return counts.entries.fold(0L) { a, (minor, pieces) -> Math.addExact(a, Math.multiplyExact(minor, pieces)) }
    }
    /** Pieces typed for one denomination ("", "12"); null when not a whole number in range. Blank is zero. */
    fun parsePieces(text: String): Long? = text.trim().let { t ->
        if (t.isEmpty()) 0L else t.takeIf { it.length <= 6 && it.all { c -> c in '0'..'9' } }?.toLong()?.takeIf { it <= CashDenominations.MAX_PIECES }
    }
    /** More than the office tolerance either way needs a supervisor; with no rule on this phone every difference does. */
    fun needsApproval(policy: VanPolicy?, varianceMinor: Long): Boolean = varianceMinor != 0L &&
        (policy?.cashReconciliation?.let { it.approvalRequired && (if (varianceMinor < 0) Math.negateExact(varianceMinor) else varianceMinor) > it.toleranceMinor } ?: true)
    fun normalizedNote(note: String?): String? = note?.trim()?.takeIf { it.isNotEmpty() }

    fun authorize(policy: VanPolicy?, tripId: String, expectedMinor: Long, declaredMinor: Long, reasonCode: String?,
        note: String?, approvalCode: String?): CashAuthorization {
        if (note != null && (note.length > 300 || note.any(Char::isISOControl))) throw CashRefused(CashProblem.NOTE_INVALID)
        val variance = Math.subtractExact(declaredMinor, expectedMinor)
        // A matching count needs no reason; anything typed for one is not kept.
        if (variance == 0L) return CashAuthorization(null, normalizedNote(note), "none", null)
        if (CashVarianceReasons.offered(policy).none { it.code == reasonCode }) throw CashRefused(CashProblem.REASON_REQUIRED)
        if (reasonCode == "other" && note.isNullOrBlank()) throw CashRefused(CashProblem.NOTE_REQUIRED)
        if (!needsApproval(policy, variance)) return CashAuthorization(reasonCode, normalizedNote(note), "none", null)
        val key = policy?.cashReconciliation?.key ?: throw CashRefused(CashProblem.APPROVAL_UNAVAILABLE)
        if (approvalCode == null || VoidApprovalCodes.normalize(approvalCode) == null) throw CashRefused(CashProblem.CODE_REQUIRED)
        val correct = try { CashApprovalCodes.verify(key, tripId, expectedMinor, declaredMinor, reasonCode!!, approvalCode) }
            catch (_: IllegalArgumentException) { throw CashRefused(CashProblem.APPROVAL_UNAVAILABLE) }
        if (!correct) throw CashRefused(CashProblem.CODE_WRONG)
        return CashAuthorization(reasonCode, normalizedNote(note), "supervisor_code", VoidApprovalCodes.normalize(approvalCode))
    }
}

/** Trip-scoped cash key (a different label from the void key, so a void code never approves cash). */
object CashApprovalCodes {
    fun code(keyB64url: String, tripId: String, expectedMinor: Long, declaredMinor: Long, reasonCode: String): String {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(keyB64url))
        require(expectedMinor >= 0 && declaredMinor >= 0)
        val key = Base64.getUrlDecoder().decode(keyB64url)
        require(key.size == 32)
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
            .doFinal("CASH|v1|$tripId|$expectedMinor|$declaredMinor|$reasonCode".toByteArray(Charsets.UTF_8))
        val o = mac[31].toInt() and 0x0f
        val bin = ((mac[o].toInt() and 0x7f) shl 24) or ((mac[o+1].toInt() and 0xff) shl 16) or
            ((mac[o+2].toInt() and 0xff) shl 8) or (mac[o+3].toInt() and 0xff)
        return (bin % 100_000_000).toString().padStart(8, '0')
    }
    fun verify(keyB64url: String, tripId: String, expectedMinor: Long, declaredMinor: Long, reasonCode: String, input: String): Boolean {
        val normalized = VoidApprovalCodes.normalize(input) ?: return false
        return MessageDigest.isEqual(code(keyB64url, tripId, expectedMinor, declaredMinor, reasonCode).toByteArray(Charsets.UTF_8),
            normalized.toByteArray(Charsets.UTF_8))
    }
}
