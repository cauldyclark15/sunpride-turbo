package com.sunpride.van.data

import java.math.BigInteger

/** Optional on older servers: absence means no evidence/approval requirement. */
data class DamagePolicy(val photoRequiredReasons: List<String>, val approvalFromUnits: Int, val photoMaxBytes: Int) {
    init { require(approvalFromUnits in 1..1_000_000 && photoMaxBytes in 1024..96_000) }
}
data class DamageRequirements(val needsApproval: Boolean, val needsPhoto: Boolean)
object DamageRules {
    val SHA256 = Regex("^[0-9a-f]{64}$")
    fun requirements(policy: DamagePolicy?, quantityBase: Long, quantityScale: Long, reason: String?): DamageRequirements {
        require(quantityBase >= 0 && quantityScale > 0)
        // The scale can be large: do not wrap an approval threshold into a small/negative Long.
        val approval = policy != null && BigInteger.valueOf(quantityBase) >=
            BigInteger.valueOf(quantityScale).multiply(BigInteger.valueOf(policy.approvalFromUnits.toLong()))
        return DamageRequirements(approval, policy != null && (approval || reason in policy.photoRequiredReasons))
    }
    fun validate(policy: DamagePolicy?, quantityBase: Long, quantityScale: Long, reason: String, photoSha256: String?) {
        require(quantityBase in 1L..999_999_999_999_999_999L)
        require(photoSha256 == null || SHA256.matches(photoSha256))
        require(!requirements(policy,quantityBase,quantityScale,reason).needsPhoto || photoSha256 != null) { "Photo required" }
    }
}
data class DamageRecord(val damageId: String, val clientRequestId: String, val productId: String,
    val quantityBase: Long, val reason: String, val status: String, val recordedAt: Long, val decisionNote: String?) {
    val statusLabel: String get() = when(status) {
        "recorded" -> "Recorded"
        "pending_approval" -> "Waiting for supervisor"
        "approved" -> "Approved"
        "rejected" -> "Rejected — returned to sellable stock"
        else -> "Needs review"
    }
}
