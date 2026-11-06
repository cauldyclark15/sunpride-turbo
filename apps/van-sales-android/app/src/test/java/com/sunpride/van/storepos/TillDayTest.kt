package com.sunpride.van.storepos

import com.sunpride.van.printing.ReceiptElement
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TillDayTest {
    private fun receipt(total: Long, tender: String = "Cash", status: String? = null, privilege: String? = null) = JSONObject(
        """{"saleId":"s","totalMinor":"$total","tenders":[{"method":"${tender.lowercase()}","label":"$tender","amountCentavos":"$total"}],
            "tax":{"vatableSalesMinor":"${total * 10 / 11}","vatMinor":"${total - total * 10 / 11}","vatExemptMinor":"0","zeroRatedMinor":"0"}
            ${privilege?.let { ""","privilege":{"byType":{$it}}""" } ?: ""}}""").apply { status?.let { put("_status", it) } }

    @Test fun cashMovementsHaveReasonsFromTheBundleOrTheOfficesDefaults() {
        assertTrue(CashReasons.forKind(CashKind.DROP).any { it.code == "safe_drop" })
        assertTrue(CashReasons.forKind(CashKind.PAID_OUT).single { it.code == "other" }.noteRequired)
        val bundle = JSONObject("""{"cashReasons":{"drop":[{"code":"x_drop","label":"Custom drop"}]}}""")
        assertEquals(listOf("x_drop"), CashReasons.forKind(CashKind.DROP, bundle).map { it.code })
        assertTrue(CashReasons.forKind(CashKind.PICKUP, bundle).any { it.code == "bank_deposit" })
    }

    @Test fun aCashPayloadCarriesTheServerFieldsAndNoSaleHasNoAmount() {
        val p = TillPayloads.cash(CashKind.DROP, 500_000, "safe_drop", " to the safe ")
        assertEquals("drop", p.getString("kind")); assertEquals("500000", p.getString("amountCentavos")); assertEquals("safe_drop", p.getString("reasonCode")); assertEquals("to the safe", p.getString("note"))
        val n = TillPayloads.cash(CashKind.NO_SALE, 0, "drawer_check", null)
        assertFalse(n.has("amountCentavos")); assertFalse(n.has("note"))
        assertThrows(IllegalArgumentException::class.java) { TillPayloads.cash(CashKind.DROP, 0, "safe_drop", null) }
    }

    @Test fun theFormTellsInPlainWordsWhatIsMissing() {
        val other = CashReason("other", "Other (write why)", true)
        assertEquals("Enter the amount.", TillPayloads.problem(CashKind.DROP, null, CashReason("a", "A"), ""))
        assertEquals("Choose why.", TillPayloads.problem(CashKind.DROP, 100, null, ""))
        assertEquals("Write why in a few words.", TillPayloads.problem(CashKind.PAID_OUT, 100, other, " "))
        assertNull(TillPayloads.problem(CashKind.PAID_OUT, 100, other, "taxi for the delivery"))
        assertNull(TillPayloads.problem(CashKind.NO_SALE, null, CashReason("drawer_check", "Checking the drawer"), ""))
    }

    @Test fun onlySupervisorsOtherThanTheCashierAreOffered() {
        val details = JSONObject("""{"supervisors":[{"profileId":"a","name":"Ana","pinId":"p1","salt":"s","hash":"h"},{"profileId":"b","name":"Ben","pinId":"p2","salt":"s","hash":"h"},{"profileId":"bad"}]}""")
        assertEquals(listOf("a", "b"), Supervisors.of(details, null).map { it.profileId })
        assertEquals(listOf("b"), Supervisors.of(details, "a").map { it.profileId })
        val j = Supervisors.json(Supervisors.of(details, null)[0], "ff")
        assertEquals("pin_offline", j.getString("method")); assertEquals("p1", j.getString("pinId")); assertEquals("ff", j.getString("proof"))
    }

    @Test fun aForceClosedSessionIsShownPlainlyAndZWaitsForEverySession() {
        val details = JSONObject("""{"sessions":[
            {"shiftId":"s1","number":"SHF-1","businessDate":"2026-11-06","openedAt":1,"closedAt":5,"status":"force_closed","dayStatus":"open"},
            {"shiftId":"s2","number":null,"businessDate":null,"openedAt":6,"closedAt":null,"status":"open","dayStatus":"open"}]}""")
        val s = TillSessions.of(details)
        assertEquals(2, s.size); assertTrue(s[0].forceClosed); assertTrue(s[0].statusLabel.contains("Closed by a supervisor")); assertTrue(s[0].statusLabel.contains("not counted by you"))
        assertEquals("SHF-1", s[0].number); assertNull(s[1].number)
        assertNotNull(TillSessions.zProblem(s, false)); assertFalse(TillSessions.zReady(s, false))
        val closed = listOf(s[0])
        assertTrue(TillSessions.zReady(closed, false)); assertNull(TillSessions.zProblem(closed, false))
        assertNotNull(TillSessions.zProblem(closed, true))
        assertEquals("Z is already done for this day.", TillSessions.zProblem(listOf(s[0].copy(dayStatus = "z_done")), false))
    }

    @Test fun theReadingAddsUpTheReceiptsAndLeavesVoidsOut() {
        val t = Readings.totals(listOf(receipt(11_000), receipt(5_500, "GCash"), receipt(2_000, status = "voided"),
            receipt(2_786, privilege = """"senior":{"discountMinor":"696","vatRemovedMinor":"418"}""")))
        assertEquals(3, t.receipts); assertEquals(11_000 + 5_500 + 2_786L, t.grossMinor)
        assertEquals(1, t.voids); assertEquals(2_000L, t.voidMinor)
        assertEquals(11_000L + 2_786L, t.tenders["Cash"]); assertEquals(5_500L, t.tenders["GCash"])
        assertEquals(696L to 418L, t.discounts["senior"])
    }

    @Test fun cashMovementsAreCountedByKind() {
        fun row(kind: String, amount: String?, status: String = "pending") = com.sunpride.van.storage.OutboxRow("s", "d", java.util.UUID.randomUUID().toString(), "r", "store.cash",
            JSONObject().put("kind", "store.cash").put("clientRequestId", "x").put("payload", JSONObject().put("kind", kind).put("shiftId", "sh").apply { amount?.let { put("amountCentavos", it) } }).toString(), 1L, status = status)
        val m = Readings.movements(listOf(row("drop", "500000"), row("drop", "100000"), row("no_sale", null), row("paid_out", "5000", "rejected")))
        assertEquals(2 to 600_000L, m[CashKind.DROP]); assertEquals(1 to 0L, m[CashKind.NO_SALE]); assertNull(m[CashKind.PAID_OUT])
    }

    @Test fun theXReadingPrintsWithoutAnyExpectedCashAndSaysItIsProvisional() {
        val totals = Readings.totals(listOf(receipt(11_000), receipt(2_786, privilege = """"senior":{"discountMinor":"696","vatRemovedMinor":"418"}""")))
        val doc = Readings.document("X", "Sample Store", "Register 1", "T-01", "Ana", 1_700_000_000_000L, totals, mapOf(CashKind.DROP to (1 to 500_000L)))
        val text = doc.elements.joinToString("\n") { when (it) { is ReceiptElement.Text -> it.text; is ReceiptElement.Columns -> it.label + " " + it.value; else -> "" } }
        assertTrue(text, text.contains("X READING")); assertTrue(text.contains("PROVISIONAL")); assertTrue(text.contains("Senior citizen"))
        assertTrue(text.contains("Cash drop (1) P5000.00")); assertTrue(text.contains("Sales P137.86"))
        assertTrue(text.contains("Expected cash is not shown")); assertFalse(text.lowercase().contains("variance"))
    }
}
