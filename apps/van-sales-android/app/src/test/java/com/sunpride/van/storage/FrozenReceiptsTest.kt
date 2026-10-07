package com.sunpride.van.storage

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.SaleReceipt
import com.sunpride.van.data.SaleReceiptLine
import com.sunpride.van.printing.ReceiptHeader
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** VAN-017: the receipt frozen at checkout reads back exactly, including nulls and amounts beyond a double. */
class FrozenReceiptsTest {
    private val lines = listOf(SaleReceiptLine(1, "p1", "Pineapple Juice 1L", "PC", "3", 8_500, 25_500),
        SaleReceiptLine(2, "p2", "Chunks \"432g\" / ñ", "CS", "0.5", 9_007_199_254_740_993L, 9_007_199_254_740_993L))

    @Test fun cashReceiptRoundTripsAsAReplay() {
        val receipt = SaleReceipt("sale-1", "R-0001", "Aling Nena Store", lines, "PHP", 34_000, 50_000, 16_000, 1_791_338_400_000L)
        val header = ReceiptHeader("Juan Dela Cruz", "TRIP-1", "V014 NBC 1234")
        assertEquals(receipt.copy(replay = true) to header, FrozenReceipts.decode(FrozenReceipts.encode(receipt, header)))
    }

    @Test fun creditReceiptKeepsReferenceDueDateAndNullHeaderFields() {
        val receipt = SaleReceipt("sale-2", "R-0002", "", lines.take(1), "PHP", 25_500, 25_500, 0, 1L, false,
            "credit", "Credit (charge to account)", PaymentKind.CREDIT, "on_account", "REF-9", "2026-11-06")
        val header = ReceiptHeader(null, null, null)
        assertEquals(receipt.copy(replay = true) to header, FrozenReceipts.decode(FrozenReceipts.encode(receipt, header)))
    }

    @Test fun unknownVersionIsRefused() {
        val json = FrozenReceipts.encode(SaleReceipt("s", "R", "C", lines, "PHP", 1, 1, 0, 1L), ReceiptHeader(null, null, null))
            .replace("\"version\":1", "\"version\":2")
        assertThrows(IllegalStateException::class.java) { FrozenReceipts.decode(json) }
    }
    @Test fun oldFrozenReceiptWithoutPromotionFieldsStillDecodes() {
        val receipt = SaleReceipt("sale-old", "R-OLD", "Store", lines.take(1), "PHP", 25_500, 25_500, 0, 1L)
        val old = JSONObject(FrozenReceipts.encode(receipt,ReceiptHeader(null,null,null)))
        old.getJSONArray("lines").getJSONObject(0).apply {
            remove("freeBase"); remove("discountMinor"); remove("promotionCode"); remove("priceListCode"); remove("freeQuantityLabel")
        }
        val decoded = FrozenReceipts.decode(old.toString()).first
        assertEquals(0L,decoded.lines.single().freeBase); assertEquals(0L,decoded.lines.single().discountMinor)
        assertNull(decoded.lines.single().promotionCode); assertNull(decoded.lines.single().priceListCode)
    }
}
