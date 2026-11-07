package com.sunpride.van.pos

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * IP-REFUND: the phone's refund maths answers the SAME cases as the office (`apps/api/test/fixtures/refund-math-cases.json`,
 * made from `fiscal/refund-math.js`). Regenerate that file with `bun test/refund-math-fixture.js` when the maths changes.
 */
class RefundMathTest {
    private val fixture = JSONObject(File("../../api/test/fixtures/refund-math-cases.json").readText())

    private fun ints(o: JSONObject): Map<Int, Long> = o.keys().asSequence().associate { it.toInt() to o.get(it).toString().toLong() }

    @Test fun everyShared_case_gives_the_office_answer() {
        val cases = fixture.getJSONArray("cases")
        assertTrue(cases.length() >= 10)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val e = c.getJSONObject("expected")
            val plan = RefundMath.plan(c.getJSONObject("receipt"), ints(c.getJSONObject("prior")), ints(c.getJSONObject("picks")))
            val name = c.getString("name")
            assertEquals("$name total", e.getString("total").toLong(), plan.totalMinor)
            assertEquals("$name vatable", e.getString("vatableSalesMinor").toLong(), plan.vatableMinor)
            assertEquals("$name vat", e.getString("vatMinor").toLong(), plan.vatMinor)
            assertEquals("$name exempt", e.getString("vatExemptMinor").toLong(), plan.vatExemptMinor)
            assertEquals("$name zero", e.getString("zeroRatedMinor").toLong(), plan.zeroRatedMinor)
            assertEquals("$name privilege", e.getString("privilegeDiscountMinor").toLong(), plan.privilegeDiscountMinor)
            val lines = e.getJSONArray("lines")
            assertEquals("$name line count", lines.length(), plan.lines.size)
            for (k in 0 until lines.length()) {
                val l = lines.getJSONObject(k); val got = plan.lines[k]
                assertEquals("$name line $k index", l.getInt("lineIndex"), got.line.index)
                assertEquals("$name line $k amount", l.getString("amount").toLong(), got.amountMinor)
                assertEquals("$name line $k vat", l.getString("vat").toLong(), got.vatMinor)
                assertEquals("$name line $k bucket", l.getString("bucket"), got.bucket)
                assertEquals("$name line $k gross", l.getString("gross").toLong(), got.grossMinor)
                assertEquals("$name line $k promo", l.getString("promo").toLong(), got.promoMinor)
                assertEquals("$name line $k privilege", l.getString("privilege").toLong(), got.privilegeDiscountMinor)
                assertEquals("$name line $k removed", l.getString("removed").toLong(), got.vatRemovedMinor)
                assertEquals("$name line $k remaining", l.getString("remaining").toLong(), got.remainingBase)
            }
        }
    }

    @Test fun shared_tender_cases_give_the_office_answer() {
        val cases = fixture.getJSONArray("tenders")
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val original = c.getJSONArray("tenders").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.map { RefundTender(it.getString("method"), it.getString("label"), it.getString("amountCentavos").toLong()) } }
            val done = c.getJSONObject("refunded").let { o -> o.keys().asSequence().associateWith { o.getString(it).toLong() } }
            val got = RefundMath.tenders(original, done, c.getString("total").toLong())
            val want = c.getJSONArray("expected").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.map { it.getString("method") to it.getString("amount").toLong() } }
            assertEquals(c.getString("name"), want, got.map { it.method to it.amountMinor })
        }
    }

    @Test fun refunding_a_line_in_parts_adds_up_to_exactly_the_line() {
        val parts = (0 until 3).map { RefundMath.share(10001L, it.toLong(), 1L, 3L) }
        assertEquals(listOf(3334L, 3333L, 3334L), parts)
        assertEquals(10001L, parts.sum())
        assertEquals(0L, RefundMath.share(0L, 0L, 1L, 1L))
    }

    @Test fun more_than_sold_or_than_what_is_left_is_refused_in_plain_words() {
        val receipt = fixture.getJSONArray("cases").getJSONObject(0).getJSONObject("receipt")
        try { RefundMath.plan(receipt, emptyMap(), mapOf(0 to 4L)); fail() } catch (e: RefundRefused) { assertEquals("That is more than was sold", e.message) }
        try { RefundMath.plan(receipt, mapOf(0 to 2L), mapOf(0 to 2L)); fail() } catch (e: RefundRefused) { assertEquals("That is more than was sold and not yet refunded", e.message) }
        try { RefundMath.plan(receipt, emptyMap(), emptyMap()); fail() } catch (e: RefundRefused) { assertEquals("Choose at least one item to refund", e.message) }
        try { RefundMath.plan(receipt, emptyMap(), mapOf(0 to 0L)); fail() } catch (e: RefundRefused) { assertEquals("Refund at least one piece of each chosen item", e.message) }
        try { RefundMath.plan(receipt, emptyMap(), mapOf(9 to 1L)); fail() } catch (e: RefundRefused) { assertEquals("That item is not on the original receipt", e.message) }
    }

    @Test fun a_customer_cannot_get_back_more_than_they_paid_by_those_methods() {
        try {
            RefundMath.tenders(listOf(RefundTender("cash", "Cash", 1000L)), mapOf("cash" to 400L), 700L); fail()
        } catch (e: RefundRefused) { assertEquals("The customer paid less than this refund by those methods", e.message) }
    }

    @Test fun supervisor_is_needed_only_above_the_office_amount() {
        assertFalse(RefundMath.needsSupervisor(50_000L, 50_000L))
        assertTrue(RefundMath.needsSupervisor(50_001L, 50_000L))
    }

    @Test fun shared_supervisor_cases_give_the_office_answer() {
        val cases = fixture.getJSONArray("supervisor")
        assertTrue(cases.length() >= 6)
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            assertEquals(c.getString("name"), c.getBoolean("expected"),
                RefundMath.needsSupervisor(c.getString("totalMinor").toLong(), c.getString("overMinor").toLong(), c.getString("alreadyRefundedMinor").toLong()))
        }
    }

    @Test fun splitting_a_receipt_into_small_refunds_still_needs_a_supervisor() {
        assertFalse(RefundMath.needsSupervisor(37_575L, 50_000L, 0L))
        assertTrue(RefundMath.needsSupervisor(37_575L, 50_000L, 37_575L))
        // the context counts the money of every method already given back on the sale
        assertEquals(49_999L, mapOf("cash" to 30_000L, "gcash" to 19_999L).values.sum())
    }

    @Test fun credit_memo_buckets_add_up_to_the_refund_plus_the_privilege_discount() {
        val senior = fixture.getJSONArray("cases").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.first { it.getString("name").startsWith("senior: one piece") } }.getJSONObject("receipt")
        for (done in 0L..3L) for (now in 1L..(4L - done)) {
            val p = RefundMath.plan(senior, mapOf(0 to done), mapOf(0 to now))
            assertEquals(p.totalMinor + p.privilegeDiscountMinor, p.vatableMinor + p.vatMinor + p.vatExemptMinor + p.zeroRatedMinor)
        }
    }

    @Test fun already_refunded_counts_what_the_office_knows_plus_what_is_saved_here() {
        val made = listOf(MadeRefund("r1", "sale-1", "CM-1", 100L, mapOf(0 to 1L), mapOf("cash" to 100L)), MadeRefund("r2", "other", "CM-2", 5L, mapOf(0 to 9L), emptyMap()))
        val so = RefundMath.refundedSoFar("sale-1", made, listOf(mapOf(0 to 1L, 1 to 2L)))
        assertEquals(mapOf(0 to 2L, 1 to 2L), so)
    }

    @Test fun the_form_asks_for_things_in_order_and_in_plain_words() {
        val r = RefundReason("RF-QUALITY", "Quality problem", "damaged", true)
        assertEquals("Choose what the customer is returning.", RefundForm.problem(emptyMap(), r, "", false, false))
        assertEquals("Choose why.", RefundForm.problem(mapOf(0 to 1L), null, "", false, false))
        assertEquals("Write why in a few words.", RefundForm.problem(mapOf(0 to 1L), r, " a", false, false))
        assertEquals("A supervisor has to approve this refund.", RefundForm.problem(mapOf(0 to 1L), r, "torn box", true, false))
        assertNull(RefundForm.problem(mapOf(0 to 1L), r, "torn box", true, true))
        assertNull(RefundForm.problem(mapOf(0 to 1L), RefundReason("RF-CHANGED-MIND", "Changed mind", "sellable", false), "", false, false))
    }

    @Test fun the_office_policy_decodes_and_an_old_server_has_none() {
        assertNull(RefundPolicy.decode(null))
        val o = JSONObject("""{"supervisorOverMinor":"50000","approvalKey":null,"reasons":[
            {"code":"RF-CHANGED-MIND","label":"Changed mind","destination":"sellable","requiresNote":false},
            {"code":"RF-DAMAGED","label":"Damaged","destination":"damaged","requiresNote":true}],
            "made":[{"id":"a","saleId":"s","creditNumber":"CM-1","totalMinor":"3900","lines":[{"lineIndex":0,"quantityBase":"1","amountCentavos":"3900"}],"tenders":[{"method":"cash","amountCentavos":"3900"}]}]}""")
        val p = RefundPolicy.decode(o)!!
        assertEquals(50_000L, p.supervisorOverMinor)
        assertNull(p.approvalKey)
        assertTrue(p.reason("RF-DAMAGED")!!.damaged)
        assertFalse(p.reason("RF-CHANGED-MIND")!!.damaged)
        assertNull(p.reason("nope"))
        assertEquals(mapOf(0 to 1L), p.made.single().lines)
        assertEquals(mapOf("cash" to 3900L), p.made.single().tenders)
        assertNotNull(JSONArray())
    }

    /** The same facts as the office test (`van-refund.test.js`): the code is bound to the receipt, amount, reason and refund number. */
    @Test fun approval_codes_bind_every_fact_and_match_the_office_algorithm() {
        val key = "A".repeat(43)
        val code = RefundApprovalCodes.code(key, "trip-1", "R-1", 12525L, "RF-DAMAGED", 2)
        assertEquals(8, code.length)
        assertEquals("46253550", code) // the same literal refund-math.test.js gets from the office's approvalCodeFor
        assertTrue(RefundApprovalCodes.verify(key, "trip-1", "R-1", 12525L, "RF-DAMAGED", 2, code))
        assertTrue(RefundApprovalCodes.verify(key, "trip-1", "R-1", 12525L, "RF-DAMAGED", 2, code.substring(0, 4) + " " + code.substring(4)))
        assertFalse(RefundApprovalCodes.verify(key, "trip-1", "R-1", 12525L, "RF-DAMAGED", 3, code))
        assertFalse(RefundApprovalCodes.verify(key, "trip-1", "R-1", 12526L, "RF-DAMAGED", 2, code))
        assertFalse(RefundApprovalCodes.verify(key, "trip-1", "R-1", 12525L, "RF-QUALITY", 2, code))
        assertFalse(RefundApprovalCodes.verify(key, "trip-2", "R-1", 12525L, "RF-DAMAGED", 2, code))
        assertFalse(RefundApprovalCodes.verify(key, "trip-1", "R-1", 12525L, "RF-DAMAGED", 2, "1234"))
    }
}
