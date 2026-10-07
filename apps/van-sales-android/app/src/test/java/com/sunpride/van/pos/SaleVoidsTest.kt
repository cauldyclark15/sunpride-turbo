package com.sunpride.van.pos

import com.sunpride.van.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class SaleVoidsTest {
    private val key = "6Heg4RirM2SuTt_Pjg5QZwyqg_P-Szkdlxli4UBfz1Y"
    private val policy = VanPolicy(voidReasons = VoidReasons.ALL.map { it.code },voidApproval = VoidApproval(true,0,key))
    private fun problem(expected: VoidProblem, p: VanPolicy = policy, reason: String? = "wrong_items", note: String? = null, code: String? = null) {
        assertEquals(expected,assertThrows(VoidRefused::class.java) { VoidRules.authorize(p,"t","r",100,reason,note,code) }.problem)
    }
    @Test fun sharedVectorsAreReadInPlaceAndEveryBoundFactIsChecked() {
        val v = JSONObject(javaClass.classLoader!!.getResourceAsStream("void-approval.json")!!.bufferedReader().use { it.readText() })
        val cases = v.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i); val key = v.getString("key"); val trip = v.getString("tripId")
            val receipt = c.getString("receiptNumber"); val total = c.getString("totalMinor").toLong()
            val reason = c.getString("reasonCode"); val expected = c.getString("code")
            assertEquals(expected,VoidApprovalCodes.code(key,trip,receipt,total,reason))
            assertTrue(VoidApprovalCodes.verify(key,trip,receipt,total,reason,expected))
            assertFalse(VoidApprovalCodes.verify(key,trip,receipt+"x",total,reason,expected))
            assertFalse(VoidApprovalCodes.verify(key,trip,receipt,total+1,reason,expected))
            assertFalse(VoidApprovalCodes.verify(key,trip,receipt,total,"other",expected))
            assertFalse(VoidApprovalCodes.verify(key,trip+"x",receipt,total,reason,expected))
        }
    }
    @Test fun onlyEightAsciiDigitsAfterSpacesAndHyphensAreAccepted() {
        assertEquals("00123456",VoidApprovalCodes.normalize(" 00-12 34-56 "))
        listOf("","1234567","123456789","１２３４５６７８","1234a678","1234\t5678","12345678\n").forEach { assertNull(it,VoidApprovalCodes.normalize(it)) }
    }
    @Test fun approvalIsFailClosedAndThresholdIsInclusive() {
        assertTrue(VoidRules.needsApproval(VanPolicy(),0))
        assertFalse(VoidRules.needsApproval(policy.copy(voidApproval = VoidApproval(false,0,null)),100))
        val p = policy.copy(voidApproval = VoidApproval(true,100,key))
        assertFalse(VoidRules.needsApproval(p,99)); assertTrue(VoidRules.needsApproval(p,100)); assertTrue(VoidRules.needsApproval(p,101))
    }
    @Test fun offeredReasonsFollowOnlyKnownPolicyCodesInPolicyOrder() {
        assertEquals(listOf("other","wrong_payment"),VoidRules.offered(policy.copy(voidReasons = listOf("unknown","other","wrong_payment"))).map { it.code })
        assertEquals("Other (explain)",VoidReasons.label("other"))
    }
    @Test fun reasonNoteApprovalAndCodeRefusalsAreTyped() {
        problem(VoidProblem.VOID_UNAVAILABLE,p = policy.copy(voidReasons = emptyList()))
        problem(VoidProblem.REASON_REQUIRED,reason = null); problem(VoidProblem.REASON_REQUIRED,reason = "delete")
        problem(VoidProblem.REASON_REQUIRED,p = policy.copy(voidReasons = listOf("other")))
        problem(VoidProblem.NOTE_REQUIRED,reason = "other",note = " ")
        problem(VoidProblem.NOTE_INVALID,note = "x".repeat(301)); problem(VoidProblem.NOTE_INVALID,note = "bad\n")
        problem(VoidProblem.NOTE_INVALID,note = "bad\u007f")
        problem(VoidProblem.APPROVAL_UNAVAILABLE,p = policy.copy(voidApproval = null))
        problem(VoidProblem.APPROVAL_UNAVAILABLE,p = policy.copy(voidApproval = VoidApproval(true,0,null)))
        problem(VoidProblem.CODE_REQUIRED); problem(VoidProblem.CODE_REQUIRED,code = "1234")
        val good = VoidApprovalCodes.code(key,"t","r",100,"wrong_items")
        problem(VoidProblem.CODE_WRONG,code = if (good == "00000000") "00000001" else "00000000")
        assertEquals(VoidAuthorization("supervisor_code",good,"because"),VoidRules.authorize(policy,"t","r",100,"wrong_items"," because ",good))
        val noCode = policy.copy(voidApproval = VoidApproval(true,101,null))
        assertEquals(VoidAuthorization("none",null,null),VoidRules.authorize(noCode,"t","r",100,"wrong_items"," ",null))
    }
}
