package com.sunpride.van.pos

import com.sunpride.van.data.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** VAN-023 JVM contract tests; the approval vectors are shared with the office implementation. */
class StockReconciliationTest {
    private fun fixture() = JSONObject(javaClass.classLoader!!.getResourceAsStream("stock-approval.json")!!.bufferedReader().use { it.readText() })
    private val vector = fixture()
    private val key = vector.getString("key")
    private val trip = vector.getString("tripId")
    private val policy = VanPolicy(stockReconciliation = StockReconciliationPolicy(true,StockVarianceReasons.ALL.map { it.code },key))
    private fun lines(c: JSONObject) = (0 until c.getJSONArray("lines").length()).map { i ->
        c.getJSONArray("lines").getJSONObject(i).let { StockCountLine(it.getString("productId"),it.getString("status"),it.getString("expectedBase").toLong(),it.getString("countedBase").toLong(),it.optString("reasonCode").ifEmpty { null }) }
    }
    private fun refused(expected: StockProblem, p: VanPolicy = policy, lines: List<StockCountLine>, note: String? = null, code: String? = null) {
        val id = "6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f"
        assertEquals(expected,assertThrows(StockRefused::class.java) { StockReconciliationRules.authorize(p,trip,id,lines,note,code) }.problem)
    }

    @Test fun sharedVectorsFreezeCanonicalTextTotalsCountCodeAndApprovalCode() {
        val cases = vector.getJSONArray("cases")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i); val id = c.getString("countId"); val counted = lines(c)
            assertEquals(c.getString("canonical"),StockReconciliationRules.canonical(trip,id,counted))
            assertEquals(c.getString("countCode"),StockReconciliationRules.countCode(trip,id,counted))
            val totals = StockReconciliationRules.summary(counted)
            assertEquals(c.getInt("varianceLines"),totals.varianceLines); assertEquals(c.getString("shortBase").toLong(),totals.shortBase); assertEquals(c.getString("overBase").toLong(),totals.overBase)
            assertEquals(c.getString("code"),StockApprovalCodes.code(key,trip,c.getString("countCode"),totals.varianceLines,totals.shortBase,totals.overBase))
            assertTrue(StockApprovalCodes.verify(key,trip,c.getString("countCode"),totals.varianceLines,totals.shortBase,totals.overBase,c.getString("code")))
            assertFalse(StockApprovalCodes.verify(key,trip,c.getString("countCode"),totals.varianceLines + 1,totals.shortBase,totals.overBase,c.getString("code")))
        }
    }

    @Test fun negativeExpectedIsAllowedAndCountsAboveItAsOver() {
        val l = listOf(StockCountLine("p1","available",-4,0,"sale_or_return_not_recorded"),StockCountLine("p2","available",10,10))
        assertEquals(StockVarianceSummary(1,0,4),StockReconciliationRules.summary(l))
        assertEquals(StockProblem.REASON_REQUIRED,assertThrows(StockRefused::class.java) {
            StockReconciliationRules.authorize(policy,trip,"0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d",l.map { it.copy(reasonCode = null) },null,null)
        }.problem)
    }

    @Test fun eachDifferenceNeedsAnOfferedReasonAndOtherNeedsANote() {
        val l = listOf(StockCountLine("p1","available",10,9),StockCountLine("p1","damaged",0,0))
        refused(StockProblem.REASON_REQUIRED,lines = l)
        refused(StockProblem.NOTE_REQUIRED,lines = l.map { if (it.productId == "p1" && it.status == "available") it.copy(reasonCode = "other") else it },note = " ")
        refused(StockProblem.NOTE_INVALID,lines = l.map { if (it.status == "available") it.copy(reasonCode = "other") else it },note = "bad\n")
        val other = l.map { if (it.status == "available") it.copy(reasonCode = "other") else it }
        assertEquals(StockAuthorization("supervisor_code",StockApprovalCodes.code(key,trip,StockReconciliationRules.countCode(trip,"6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",other),1,1,0)),
            StockReconciliationRules.authorize(policy,trip,"6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",other,"note",StockApprovalCodes.code(key,trip,StockReconciliationRules.countCode(trip,"6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",other),1,1,0)))
    }

    @Test fun matchingLinesNeedNoApprovalAndMissingKeyFailsClosedForVariance() {
        val same = listOf(StockCountLine("p1","available",10,10),StockCountLine("p1","damaged",0,0))
        assertEquals(StockAuthorization("none",null),StockReconciliationRules.authorize(policy.copy(stockReconciliation = policy.stockReconciliation!!.copy(key = null)),trip,"6f1c2a4e-8b3d-4c5e-9f10-1a2b3c4d5e6f",same,null,null))
        val different = same.map { if (it.status == "available") it.copy(countedBase = 9,reasonCode = "missing") else it }
        refused(StockProblem.APPROVAL_UNAVAILABLE,policy.copy(stockReconciliation = policy.stockReconciliation!!.copy(key = null)),different)
        refused(StockProblem.CODE_WRONG,lines = different,code = "00000000")
    }

    @Test fun invalidCountsAndTooManyLinesAreRefused() {
        refused(StockProblem.COUNT_INVALID,lines = listOf(StockCountLine("p","available",0,-1),StockCountLine("p","damaged",0,0)))
        refused(StockProblem.COUNT_INVALID,lines = listOf(StockCountLine("p","available",0,0,"missing"),StockCountLine("p","damaged",0,0)))
        refused(StockProblem.TOO_MANY_LINES,lines = (0..1200).flatMap { listOf(StockCountLine("p$it","available",0,0),StockCountLine("p$it","damaged",0,0)) })
    }
}