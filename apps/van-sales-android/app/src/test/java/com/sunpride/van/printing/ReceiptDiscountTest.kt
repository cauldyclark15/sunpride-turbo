package com.sunpride.van.printing

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.SaleReceipt
import com.sunpride.van.data.SaleReceiptLine
import com.sunpride.van.pos.QuotedPayment
import com.sunpride.van.pos.QuotedSplit
import com.sunpride.van.data.PaymentMethod
import com.sunpride.van.pos.PaymentState
import com.sunpride.van.selling.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** IP-HH2: the receipt shows the statutory discount and a split payment, and a reprint keeps them. */
class ReceiptDiscountTest {
    private val header = ReceiptHeader("Juan Dela Cruz", "TRIP-1", "V014")
    private val gcash = PaymentMethod("gcash", "GCash", PaymentKind.OTHER, true, "Ref")
    private fun fiscal(extra: JSONObject.() -> Unit) = JSONObject().put("documentType", "sales_invoice").put("documentNumber", "SI-1")
        .put("registration", JSONObject().put("entityName", "SUNPRIDE").put("branchName", "Cebu").put("address", "Cebu City").put("tin", "123").put("permitReference", JSONObject.NULL).put("sample", true))
        .put("tax", JSONObject().put("vatableSalesMinor", "0").put("vatMinor", "0").put("vatExemptMinor", "3482").put("zeroRatedMinor", "0").put("privilegeDiscountMinor", "696").put("vatRemovedMinor", "418").put("totalMinor", "2786")
            .put("lines", org.json.JSONArray().put(JSONObject().put("lineNumber", 1).put("treatment", "vatable").put("privilegeDiscountMinor", "696"))))
        .apply(extra).toString()
    private fun receipt(fiscalJson: String, kind: PaymentKind = PaymentKind.CASH, method: String = "cash", tendered: Long = 3_000, change: Long = 214) =
        SaleReceipt("sale-1", "SI-000000001", "Aling Nena Store", listOf(SaleReceiptLine(1, "p1", "Pineapple Juice 1L", "PC", "1", 3_900, 2_786)), "PHP", 2_786, tendered, change, 1_791_338_400_000L,
            false, method, if (method == "split") "Cash + GCash" else "Cash", kind, "paid", null, null, fiscalJson)
    private fun text(r: SaleReceipt, reprint: Boolean = false): String {
        val attempt = PrintAttempt("p", "sale-1", if (reprint) PrintKind.REPRINT else PrintKind.ORIGINAL, if (reprint) 1 else 0, if (reprint) "customer_copy" else null, PrintOutcome.STARTED, 1)
        return SaleReceiptDocuments.build(r, header, attempt, 5L).elements.joinToString("\n") {
            when (it) { is ReceiptElement.Text -> it.text; is ReceiptElement.Columns -> it.label + " " + it.value; else -> "" }
        }
    }
    private val claim = DiscountClaim(PrivilegeType.SENIOR, "SC-123456", "Juan Dela Cruz")
    private val legal = Privilege.cart(listOf(LegalInput("p1", 3_900, 0, TaxFact("vatable", 1200))), claim).getOrThrow()

    @Test fun theReceiptShowsTheDiscountTheVatRemovedTheHolderAndTheId() {
        val t = text(receipt(fiscal { put("discountClaim", ReceiptDiscounts.claimJson(claim, legal)) }))
        assertTrue(t, t.contains("Senior citizen -P6.96"))                 // on the item line
        assertTrue(t.contains("Senior citizen discount -P6.96")); assertTrue(t.contains("VAT removed P4.18"))
        assertTrue(t.contains("Senior citizen: Juan Dela Cruz")); assertTrue(t.contains("ID: SC-123456")); assertTrue(t.contains("TOTAL P27.86"))
        assertTrue("a reprint keeps the discount lines", text(receipt(fiscal { put("discountClaim", ReceiptDiscounts.claimJson(claim, legal)) }), reprint = true).contains("ID: SC-123456"))
    }

    @Test fun aSaleWithNoClaimPrintsNoDiscountLines() {
        val t = text(receipt(fiscal { }))
        assertFalse(t.contains("VAT removed")); assertFalse(t.contains("ID:"))
    }

    @Test fun aSplitPaymentPrintsBothTendersAndTheChangeFromCashOnly() {
        val split = QuotedSplit(QuotedPayment(PaymentMethod.CASH, 1_786, 2_000, 214, null, PaymentState.PAID, null), QuotedPayment(gcash, 1_000, null, 0, "GC-77", PaymentState.AWAITING_CONFIRMATION, null))
        val t = text(receipt(fiscal { put("payments", ReceiptDiscounts.paymentsJson(split)) }, PaymentKind.OTHER, "split", 2_000, 214))
        assertTrue(t, t.contains("Cash P17.86")); assertTrue(t.contains("Cash received P20.00")); assertTrue(t.contains("Change P2.14")); assertTrue(t.contains("GCash P10.00")); assertTrue(t.contains("Ref GC-77"))
    }
}
