package com.sunpride.van.storepos

import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.storage.RefundNotAllowed
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.util.UUID

/** SP-0169 POS-026 / blind count: the phone says what the office would refuse, before the cashier saves it. */
class StoreReversalsTest {
    private val mode = UUID.randomUUID().toString()
    private val register = UUID.randomUUID().toString()
    private val shift = UUID.randomUUID().toString()
    private val sale = UUID.randomUUID().toString()
    private fun config(reversals: JSONArray? = null) = StorePosConfig("store", mode, register, "Register 1", "Colon", "C-01", UUID.randomUUID().toString(), null,
        JSONObject().apply { reversals?.let { put("reversals", it) }; put("refunds", JSONObject().put("supervisorOverMinor", "50000").put("reasons", JSONArray().put(JSONObject().put("code", "RF-CHANGED-MIND").put("label", "Changed mind").put("destination", "sellable"))).put("made", JSONArray())) })
    private fun row(kind: String, payload: JSONObject, status: String = "pending", code: String? = null, id: String = UUID.randomUUID().toString()): OutboxRow {
        payload.put("shiftId", shift).put("registerId", register).put("modeVersionId", mode).put("deviceTime", 1L)
        return OutboxRow("v2|cashier|scope", "device", id, register, kind, JSONObject().put("kind", kind).put("clientRequestId", id).put("payload", payload).toString(), 1L, status = status, rejectionCode = code)
    }
    private fun receipt() = JSONObject().put("saleId", sale).put("receiptNumber", "SI-6").put("totalMinor", "17010").put("tenders", JSONArray())
        .put("lines", JSONArray().put(JSONObject().put("productId", "p").put("quantityBase", "1").put("lineTotalCentavos", "17010").put("unitPriceCentavos", "17010")))
    private fun remote(status: String, kind: String = "refund") = JSONArray().put(JSONObject().put("id", UUID.randomUUID().toString()).put("saleId", sale).put("shiftId", shift).put("kind", kind).put("status", status))

    @Test fun itemRefundIsStoppedWhileAWholeReceiptRefundWaitsOrWasApproved() {
        // CM-000000001 on SI-6: the whole-receipt refund request was saved first; the office refuses the item refund (refunds.js:53).
        val waiting = StoreRefunds.context(config(), listOf(row("store.refund", JSONObject().put("saleId", sale).put("reason", "unopened"))), receipt(), true, false)
        assertEquals("A whole-receipt refund is waiting for the office on this receipt. Refund by item only after the office rejects it.", waiting.problem)
        assertEquals("A whole-receipt void is waiting for the office on this receipt. Refund by item only after the office rejects it.",
            StoreRefunds.context(config(remote("pending", "void")), emptyList(), receipt(), true, false).problem)
        assertTrue(StoreRefunds.context(config(remote("approved")), emptyList(), receipt(), true, false).problem!!.contains("refunded in full"))
        // Rejected by the office (the lane's SI-6 at 03:54): item refunds are allowed again.
        assertNull(StoreRefunds.context(config(remote("rejected")), emptyList(), receipt(), true, false).problem)
        val e = assertThrows(RefundNotAllowed::class.java) { StoreRefunds.check(waiting, mapOf(0 to 1L), "RF-CHANGED-MIND", null, 17010L) }
        assertTrue(e.message!!.startsWith("A whole-receipt refund is waiting"))
    }

    @Test fun blindCountWaitsForUndecidedVoidAndRefundRequests() {
        val voidReq = row("store.void", JSONObject().put("saleId", sale).put("reason", "Wrong item scanned"))
        assertEquals(1, StoreReversals.pendingInShift(config(), listOf(voidReq), shift).size)
        assertEquals(2, StoreReversals.pendingInShift(config(remote("pending")), listOf(voidReq), shift).size)
        assertTrue(StoreReversals.countProblem(2)!!.startsWith("2 void or refund requests are waiting for the office"))
        // Once sent, the office's decision is the truth.
        assertEquals(0, StoreReversals.pendingInShift(config(remote("approved", "void")), listOf(voidReq.copy(status = "done")), shift).size)
        assertNull(StoreReversals.countProblem(0))
    }

    @Test fun aRefusedCreditMemoStaysOnTheReceiptWithWhatToDo() {
        val p = JSONObject().put("saleId", sale).put("refundId", "r1").put("creditNumber", "CM-000000002").put("expectedCentavos", "17010").put("lines", JSONArray())
        assertTrue(StoreRefunds.local(listOf(row(StoreRefunds.KIND, p, "rejected", com.sunpride.van.selling.RefusedReceipt.CODE))).isEmpty())
        val (m, why) = StoreRefunds.refused(listOf(row(StoreRefunds.KIND, JSONObject(p.toString()), "rejected", com.sunpride.van.selling.RefusedReceipt.CODE))).single()
        assertEquals("CM-000000002", m.getString("creditNumber"))
        assertTrue(why.contains("recorded as spoiled"))
        assertTrue(com.sunpride.van.selling.RefusedReceipt.message("CM-000000002", StoreRefunds.KIND).contains("next refund can go ahead"))
    }
}
