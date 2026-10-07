package com.sunpride.van.pos

import com.sunpride.van.data.VanPolicy
import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

data class VoidReason(val code: String, val label: String)
object VoidReasons {
    val ALL = listOf(
        VoidReason("wrong_items","Wrong items"), VoidReason("wrong_quantity","Wrong quantity"),
        VoidReason("wrong_customer","Wrong customer"), VoidReason("wrong_payment","Wrong payment"),
        VoidReason("customer_cancelled","Customer cancelled"), VoidReason("other","Other (explain)"))
    fun offered(policy: VanPolicy): List<VoidReason> = policy.voidReasons.mapNotNull { code -> ALL.firstOrNull { it.code == code } }
    fun label(code: String): String = ALL.firstOrNull { it.code == code }?.label ?: code
}

/** Trip-scoped approval key, never the office secret. The code binds all the details read to the supervisor. */
object VoidApprovalCodes {
    fun code(keyB64url: String, tripId: String, receiptNumber: String, totalMinor: Long, reasonCode: String): String {
        require(Regex("^[A-Za-z0-9_-]{43}$").matches(keyB64url))
        val key = Base64.getUrlDecoder().decode(keyB64url)
        require(key.size == 32)
        val mac = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(key,"HmacSHA256")) }
            .doFinal("VOID|v1|$tripId|$receiptNumber|$totalMinor|$reasonCode".toByteArray(Charsets.UTF_8))
        val o = mac[31].toInt() and 0x0f
        val bin = ((mac[o].toInt() and 0x7f) shl 24) or ((mac[o+1].toInt() and 0xff) shl 16) or
            ((mac[o+2].toInt() and 0xff) shl 8) or (mac[o+3].toInt() and 0xff)
        return (bin % 100_000_000).toString().padStart(8,'0')
    }
    fun normalize(input: String): String? = input.filterNot { it == ' ' || it == '-' }
        .takeIf { it.length == 8 && it.all { c -> c in '0'..'9' } }
    fun verify(keyB64url: String, tripId: String, receiptNumber: String, totalMinor: Long, reasonCode: String, input: String): Boolean {
        val normalized = normalize(input) ?: return false
        return MessageDigest.isEqual(code(keyB64url,tripId,receiptNumber,totalMinor,reasonCode).toByteArray(Charsets.UTF_8),
            normalized.toByteArray(Charsets.UTF_8))
    }
}

enum class VoidProblem { VOID_UNAVAILABLE, SALE_NOT_FOUND, NOT_THIS_TRIP, HELD, ALREADY_VOIDED, SALE_HAS_RETURNS, REASON_REQUIRED,
    NOTE_REQUIRED, NOTE_INVALID, APPROVAL_UNAVAILABLE, CODE_REQUIRED, CODE_WRONG,
    /** VAN-022: the trip's cash is counted; a void now would change the cash the count was approved against. */
    CASH_COUNTED,
    /** VAN-023: the approved physical count freezes every stock-changing action. */
    STOCK_COUNTED }
class VoidRefused(val problem: VoidProblem) : IllegalStateException(problem.name)
data class VoidAuthorization(val method: String, val code: String?, val note: String?)
data class SaleVoidResult(val saleId: String, val voidId: String, val receiptNumber: String, val reasonCode: String,
    val approved: Boolean, val createdAt: Long, val replay: Boolean)

object VoidRules {
    fun offered(policy: VanPolicy): List<VoidReason> = VoidReasons.offered(policy)
    fun needsApproval(policy: VanPolicy, totalMinor: Long): Boolean = policy.voidApproval?.let {
        it.required && totalMinor >= it.thresholdMinor
    } ?: true
    fun normalizedNote(note: String?): String? = note?.trim()?.takeIf { it.isNotEmpty() }
    fun authorize(policy: VanPolicy, tripId: String, receiptNumber: String, totalMinor: Long,
        reasonCode: String?, note: String?, approvalCode: String?): VoidAuthorization {
        if (offered(policy).isEmpty()) throw VoidRefused(VoidProblem.VOID_UNAVAILABLE)
        if (offered(policy).none { it.code == reasonCode }) throw VoidRefused(VoidProblem.REASON_REQUIRED)
        if (reasonCode == "other" && note.isNullOrBlank()) throw VoidRefused(VoidProblem.NOTE_REQUIRED)
        if (note != null && (note.length > 300 || note.any(Char::isISOControl))) throw VoidRefused(VoidProblem.NOTE_INVALID)
        if (!needsApproval(policy,totalMinor)) return VoidAuthorization("none",null,normalizedNote(note))
        val key = policy.voidApproval?.key ?: throw VoidRefused(VoidProblem.APPROVAL_UNAVAILABLE)
        if (approvalCode == null || VoidApprovalCodes.normalize(approvalCode) == null) throw VoidRefused(VoidProblem.CODE_REQUIRED)
        val correct = try { VoidApprovalCodes.verify(key,tripId,receiptNumber,totalMinor,reasonCode!!,approvalCode) }
            catch (_: IllegalArgumentException) { throw VoidRefused(VoidProblem.APPROVAL_UNAVAILABLE) }
        if (!correct) throw VoidRefused(VoidProblem.CODE_WRONG)
        return VoidAuthorization("supervisor_code",VoidApprovalCodes.normalize(approvalCode),normalizedNote(note))
    }
}
