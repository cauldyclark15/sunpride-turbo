package com.sunpride.van.pos

import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import com.sunpride.van.data.VanPolicy
import java.security.MessageDigest
import java.util.Base64
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** VAN-023 end-of-trip stock count. Reasons are deliberately a small office-controlled enum. */
data class StockVarianceReason(val code: String, val label: String)

object StockVarianceReasons {
    val ALL = listOf(
        StockVarianceReason("missing", "Missing / short"),
        StockVarianceReason("extra_found", "Extra found on truck"),
        StockVarianceReason("damaged_not_recorded", "Damage not recorded"),
        StockVarianceReason("sale_or_return_not_recorded", "Sale or return not recorded"),
        StockVarianceReason("free_goods_or_sample", "Free goods or sample given"),
        StockVarianceReason("loading_error", "Loaded wrong"),
        StockVarianceReason("other", "Other (explain)")
    )

    fun offered(policy: VanPolicy?): List<StockVarianceReason> = policy?.stockReconciliation?.reasons
        ?.mapNotNull { code -> ALL.firstOrNull { it.code == code } } ?: ALL

    fun label(code: String): String = ALL.firstOrNull { it.code == code }?.label ?: code
}

/** One sellable or damaged count line. Quantities are integral base units. */
data class StockCountLine(
    val productId: String,
    val status: String,
    val expectedBase: Long,
    val countedBase: Long,
    val reasonCode: String? = null
) {
    companion object {
        const val AVAILABLE = "available"
        const val DAMAGED = "damaged"
        val STATUSES = setOf(AVAILABLE, DAMAGED)
    }
}

data class StockVarianceSummary(val varianceLines: Int, val shortBase: Long, val overBase: Long) {
    val anyVariance: Boolean get() = varianceLines != 0
}

data class StockCountRequest(
    val reconciliationId: String,
    /** Includes the expected values the seller saw, so the store can detect a changed projection. */
    val lines: List<StockCountLine>,
    val note: String? = null,
    val approvalCode: String? = null
)

data class StockAuthorization(val method: String, val code: String?)

enum class StockProblem {
    NOT_ON_ROUTE, HELD, ALREADY_COUNTED, EXPECTED_CHANGED, COUNT_INVALID, TOO_MANY_LINES,
    REASON_REQUIRED, NOTE_REQUIRED, NOTE_INVALID, APPROVAL_UNAVAILABLE, CODE_REQUIRED, CODE_WRONG,
    STOCK_COUNTED,
    /** VAN-024: the trip is closed on this phone. */
    TRIP_CLOSED
}

class StockRefused(val problem: StockProblem) : IllegalStateException(problem.name)

data class StockCountResult(
    val reconciliationId: String,
    val tripNumber: String,
    val countCode: String,
    val lines: List<StockCountLine>,
    val varianceLines: Int,
    val shortBase: Long,
    val overBase: Long,
    val note: String?,
    val approved: Boolean,
    val createdAt: Long,
    val replay: Boolean = false
)

data class StockLineSummary(
    val productId: String,
    val productCode: String,
    val productName: String,
    val uomCode: String,
    val quantityScale: Long,
    val status: String,
    val expectedBase: Long,
    val countedBase: Long?,
    val reasonCode: String?
)

data class StockSummary(
    val tripId: String,
    val tripNumber: String,
    val countable: Boolean,
    val lines: List<StockLineSummary>,
    val saved: StockCountResult?
)

object StockReconciliationRules {
    const val MAX_LINES = 1_200
    const val MAX_BASE = 999_999_999_999_999_999L
    private val uuidV4 = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
    private val keyPattern = Regex("^[A-Za-z0-9_-]{43}$")

    fun newCountId(): String = UUID.randomUUID().toString()
    fun validId(id: String): Boolean = uuidV4.matches(id)

    /** One line for both stock statuses of every product in the cache. */
    fun expectedLines(products: List<Product>, stock: List<TruckStock>): List<StockCountLine> {
        val balances = stock.associateBy { it.productId }
        return products.sortedBy { it.productId }.flatMap { p ->
            val s = balances[p.productId]
            listOf(
                StockCountLine(p.productId, StockCountLine.AVAILABLE, s?.availableBase ?: 0L, 0L),
                StockCountLine(p.productId, StockCountLine.DAMAGED, s?.damagedBase ?: 0L, 0L)
            )
        }
    }

    fun summary(lines: List<StockCountLine>): StockVarianceSummary {
        var different = 0
        var short = 0L
        var over = 0L
        lines.forEach { line ->
            val delta = try { Math.subtractExact(line.countedBase, line.expectedBase) }
            catch (_: ArithmeticException) { throw StockRefused(StockProblem.COUNT_INVALID) }
            if (delta != 0L) {
                different++
                if (delta < 0) short = Math.addExact(short, Math.negateExact(delta))
                else over = Math.addExact(over, delta)
            }
        }
        return StockVarianceSummary(different, short, over)
    }

    /** Canonical text is the cross-language approval contract. */
    fun canonical(tripId: String, countId: String, lines: List<StockCountLine>): String {
        val sorted = lines.sortedWith(compareBy<StockCountLine> { it.productId }.thenBy { it.status })
        return (listOf("STOCKCOUNT|v1|$tripId|$countId") + sorted.map { line ->
            "${line.productId}|${line.status}|${line.expectedBase}|${line.countedBase}|${line.reasonCode ?: ""}"
        }).joinToString("\n")
    }

    fun countCode(tripId: String, countId: String, lines: List<StockCountLine>): String =
        MessageDigest.getInstance("SHA-256").digest(canonical(tripId, countId, lines).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02X".format(it) }.take(12)

    fun displayCountCode(code: String): String = code.take(4) + "-" + code.drop(4).take(4) + "-" + code.drop(8).take(4)

    fun needsApproval(policy: VanPolicy?, anyVariance: Boolean): Boolean = anyVariance &&
        (policy?.stockReconciliation?.approvalRequired ?: true)

    fun normalizedNote(note: String?): String? = note?.trim()?.takeIf { it.isNotEmpty() }

    /** Validates all lines and returns the normalized authorization facts. */
    fun authorize(
        policy: VanPolicy?, tripId: String, countId: String, lines: List<StockCountLine>,
        note: String?, approvalCode: String?
    ): StockAuthorization {
        validateLines(policy, lines)
        val normalizedNote = normalizedNote(note)
        if (note != null && (note.length > 300 || note.any(Char::isISOControl))) throw StockRefused(StockProblem.NOTE_INVALID)
        val summary = summary(lines)
        val hasOther = lines.any { it.reasonCode == "other" }
        if (hasOther && normalizedNote == null) throw StockRefused(StockProblem.NOTE_REQUIRED)
        if (!needsApproval(policy, summary.anyVariance)) return StockAuthorization("none", null)
        val key = policy?.stockReconciliation?.key ?: throw StockRefused(StockProblem.APPROVAL_UNAVAILABLE)
        val count = countCode(tripId, countId, lines)
        if (approvalCode == null || VoidApprovalCodes.normalize(approvalCode) == null) throw StockRefused(StockProblem.CODE_REQUIRED)
        val correct = try {
            StockApprovalCodes.verify(key, tripId, count, summary.varianceLines, summary.shortBase, summary.overBase, approvalCode)
        } catch (_: IllegalArgumentException) { throw StockRefused(StockProblem.APPROVAL_UNAVAILABLE) }
        if (!correct) throw StockRefused(StockProblem.CODE_WRONG)
        return StockAuthorization("supervisor_code", VoidApprovalCodes.normalize(approvalCode))
    }

    fun validateLines(policy: VanPolicy?, lines: List<StockCountLine>) {
        if (lines.size > MAX_LINES) throw StockRefused(StockProblem.TOO_MANY_LINES)
        if (lines.isEmpty() || lines.size % 2 != 0) throw StockRefused(StockProblem.COUNT_INVALID)
        if (lines.map { it.productId to it.status }.distinct().size != lines.size ||
            lines.any { it.productId.isBlank() || it.status !in StockCountLine.STATUSES || it.countedBase !in 0L..MAX_BASE })
            throw StockRefused(StockProblem.COUNT_INVALID)
        val reasons = StockVarianceReasons.offered(policy).map { it.code }.toSet()
        lines.forEach { line ->
            val differs = line.expectedBase != line.countedBase
            if (differs && line.reasonCode !in reasons) throw StockRefused(StockProblem.REASON_REQUIRED)
            if (!differs && !line.reasonCode.isNullOrBlank()) throw StockRefused(StockProblem.COUNT_INVALID)
        }
    }
}

/** Trip-scoped approval code for (trip, count code, variance line count, short and over units). */
object StockApprovalCodes {
    fun code(keyB64url: String, tripId: String, countCode: String, varianceLines: Int, shortBase: Long, overBase: Long): String {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(keyB64url))
        require(Regex("^[0-9A-F]{12}$").matches(countCode))
        require(varianceLines >= 0 && shortBase >= 0 && overBase >= 0)
        val key = Base64.getUrlDecoder().decode(keyB64url)
        require(key.size == 32)
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key, "HmacSHA256")) }
            .doFinal("STOCK|v1|$tripId|$countCode|$varianceLines|$shortBase|$overBase".toByteArray(Charsets.UTF_8))
        val offset = mac[31].toInt() and 0x0f
        val binary = ((mac[offset].toInt() and 0x7f) shl 24) or ((mac[offset + 1].toInt() and 0xff) shl 16) or
            ((mac[offset + 2].toInt() and 0xff) shl 8) or (mac[offset + 3].toInt() and 0xff)
        return (binary % 100_000_000).toString().padStart(8, '0')
    }

    fun verify(keyB64url: String, tripId: String, countCode: String, varianceLines: Int, shortBase: Long, overBase: Long, input: String): Boolean {
        val normalized = VoidApprovalCodes.normalize(input) ?: return false
        return MessageDigest.isEqual(code(keyB64url, tripId, countCode, varianceLines, shortBase, overBase).toByteArray(Charsets.UTF_8), normalized.toByteArray(Charsets.UTF_8))
    }
}