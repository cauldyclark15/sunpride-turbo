package com.sunpride.van.data

import org.junit.Assert.*
import org.junit.Test

class DamageRulesTest {
    private val policy = DamagePolicy(listOf("crushed","leaking","spoiled","other"),12,90_000)
    @Test fun approvalBoundaryIsInclusiveAndScaledExactly() {
        for (scale in listOf(1L,1000L,1_000_000L)) {
            assertEquals(DamageRequirements(false,false),DamageRules.requirements(policy,12*scale-1,scale,"expired"))
            assertEquals(DamageRequirements(true,true),DamageRules.requirements(policy,12*scale,scale,"expired"))
            assertEquals(DamageRequirements(true,true),DamageRules.requirements(policy,12*scale+1,scale,"expired"))
        }
    }
    @Test fun requiredReasonNeedsPhotoBelowApprovalAndExpiredDoesNot() {
        policy.photoRequiredReasons.forEach { assertEquals(DamageRequirements(false,true),DamageRules.requirements(policy,1,1000,it)) }
        assertEquals(DamageRequirements(false,false),DamageRules.requirements(policy,1,1,"expired"))
    }
    @Test fun absentPolicyIsLegacyNoPhotoAndNoApproval() {
        assertEquals(DamageRequirements(false,false),DamageRules.requirements(null,999_999_999_999_999_999,1,"crushed"))
        DamageRules.validate(null,12,1,"crushed",null)
    }
    @Test fun largeScaleCannotOverflowApprovalThreshold() {
        assertFalse(DamageRules.requirements(policy,999_999_999_999_999_999,999_999_999_999_999_999,"expired").needsApproval)
    }
    @Test fun savingRequiresCanonicalDigestWhenPhotoIsRequired() {
        assertThrows(IllegalArgumentException::class.java) { DamageRules.validate(policy,12,1,"expired",null) }
        assertThrows(IllegalArgumentException::class.java) { DamageRules.validate(policy,1,1,"crushed","A".repeat(64)) }
        DamageRules.validate(policy,1,1,"crushed","a".repeat(64))
        DamageRules.validate(policy,11,1,"expired",null)
    }
    @Test fun policyBoundsAndUnknownScaleAreRefused() {
        assertThrows(IllegalArgumentException::class.java) { DamagePolicy(emptyList(),0,90_000) }
        assertThrows(IllegalArgumentException::class.java) { DamagePolicy(emptyList(),12,96_001) }
        assertThrows(IllegalArgumentException::class.java) { DamageRules.requirements(policy,1,0,"expired") }
    }
    @Test fun supervisorStatusLabelsArePlainAndRejectionExplainsStock() {
        val record = DamageRecord("d","r","p","PC",1,1,"expired","recorded",1,null)
        assertEquals("Recorded",record.statusLabel)
        assertEquals("Waiting for supervisor",record.copy(status="pending_approval").statusLabel)
        assertEquals("Approved",record.copy(status="approved").statusLabel)
        assertEquals("Rejected — returned to sellable stock",record.copy(status="rejected").statusLabel)
    }
}
