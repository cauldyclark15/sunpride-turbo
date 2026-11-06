package com.sunpride.van.storepos

import com.sunpride.van.pos.CartLine
import com.sunpride.van.pos.CheckoutProblem
import com.sunpride.van.pos.CheckoutRefused
import com.sunpride.van.selling.DiscountClaim
import com.sunpride.van.selling.PrivilegeType
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** IP-HH2: the discount claim on a store sale: the same engine and formulas as the van, with tax facts from the store's catalogue. */
class StoreClaimTest {
    private fun row(id: String, price: Long, tax: String?, bps: Int = 1200) = JSONObject().put("productId", id).put("code", "C-$id").put("name", "Product $id").put("uomCode", "PC")
        .put("quantityScale", "1").put("barcodes", JSONArray()).put("availableBase", "50").put("unitPriceMinor", price.toString()).put("sourcePriceListId", "list")
        .put("priceFrom", 1L).put("units", JSONObject().put("PC", "1")).apply { tax?.let { put("taxTreatment", it).put("taxBasisPoints", bps) } }
    private fun config(vararg rows: JSONObject) = StorePosConfig("store", "mode", "reg", "Register 1", "Store", "T-01", "policy", null,
        JSONObject().put("transactionsEnabled", true).put("catalogue", JSONArray(rows.toList())).put("governedPromotions", JSONArray())
            .put("customer", JSONObject().put("outletId", "o").put("code", "S").put("name", "Store").put("address", JSONObject.NULL).put("source", "unplanned").put("sequence", JSONObject.NULL).put("priceListId", "reg")))
    private val senior = DiscountClaim(PrivilegeType.SENIOR, "SC-123456", "Juan Dela Cruz")

    @Test fun theBundleHasToCarryTaxForEveryProductBeforeAClaimIsOffered() {
        assertTrue(StoreCheckout.claimsPossible(config(row("a", 3_900, "vatable"))))
        assertFalse(StoreCheckout.claimsPossible(config(row("a", 3_900, null))))
        assertFalse(StoreCheckout.claimsPossible(config(row("a", 3_900, "vatable"), row("b", 1_000, null))))
        assertFalse(StoreCheckout.claimsPossible(config()))
        // IP-INT3: a product with no price is not sold, so it needs no tax fact.
        assertTrue(StoreCheckout.claimsPossible(config(row("a", 3_900, "vatable"), row("b", 1_000, null).put("unitPriceMinor", JSONObject.NULL))))
    }

    @Test fun aSeniorClaimOnAStoreSaleGivesTwentySevenPesosEightySix() {
        val q = StoreCheckout.quote(config(row("a", 3_900, "vatable")), emptyList(), listOf(CartLine("a", 1)), 100, senior)
        assertEquals(2_786L, q.totalMinor); assertEquals(696L, q.legal!!.privilegeDiscount); assertEquals(418L, q.legal!!.vatRemoved)
        assertEquals(3_900L, StoreCheckout.quote(config(row("a", 3_900, "vatable")), emptyList(), listOf(CartLine("a", 1)), 100).totalMinor)
    }

    @Test fun withoutTaxFactsTheClaimIsRefusedInsteadOfGuessed() {
        val e = runCatching { StoreCheckout.quote(config(row("a", 3_900, null)), emptyList(), listOf(CartLine("a", 1)), 100, senior) }.exceptionOrNull() as CheckoutRefused
        assertEquals(CheckoutProblem.DISCOUNT_TAX_UNKNOWN, e.issues.single().problem)
    }

    @Test fun theStoreReceiptPrintsTheDiscountLines() {
        val receipt = JSONObject("""{"saleId":"s","store":"Store","register":"Register 1","terminal":"T-01","receiptNumber":"SI-1","cashier":"Ana","customer":"Walk-in","soldAt":1700000000000,
            "totalMinor":"2786","tenders":[{"method":"cash","label":"Cash","amountCentavos":"2786","tenderedCentavos":"3000","changeCentavos":"214"}],
            "tax":{"vatableSalesMinor":"0","vatMinor":"0","vatExemptMinor":"3482","zeroRatedMinor":"0"},
            "lines":[{"description":"Pineapple Juice 1L","quantity":"1","uom":"PC","lineTotalCentavos":"2786"}],
            "discountClaim":{"type":"senior","label":"Senior citizen","idNumber":"SC-123456","holderName":"Juan Dela Cruz","applied":true,"privilegeDiscountMinor":"696","vatRemovedMinor":"418"}}""")
        val text = StoreTransactions.document(receipt).elements.joinToString("\n") {
            when (it) { is com.sunpride.van.printing.ReceiptElement.Text -> it.text; is com.sunpride.van.printing.ReceiptElement.Columns -> it.label + " " + it.value; else -> "" }
        }
        assertTrue(text, text.contains("Senior citizen discount -P6.96")); assertTrue(text.contains("VAT removed P4.18"))
        assertTrue(text.contains("Senior citizen: Juan Dela Cruz")); assertTrue(text.contains("ID: SC-123456")); assertTrue(text.contains("TOTAL P27.86"))
    }
}
