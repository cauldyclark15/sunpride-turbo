package com.sunpride.van.selling

import com.sunpride.van.data.BarcodeUnit
import com.sunpride.van.data.Product
import com.sunpride.van.pos.CartLine
import org.junit.Assert.*
import org.junit.Test

class SellingRulesTest {
    // Pineapple Juice 1L: sold in pieces (scale 1), a case of 12.
    private val juice = Product("p1", "SP-PJ-1L", "Pineapple Juice 1L", "PC", 1, listOf("4800000000017", "14800000000014"),
        listOf(BarcodeUnit("4800000000017", "PC", 1), BarcodeUnit("14800000000014", "CS", 12)))
    private val chunks = Product("p2", "SP-PC-432", "Pineapple Chunks 432g", "PC", 1, listOf("4800000000024"))
    private val noCaseSize = Product("p3", "SP-X", "Mystery Case", "PC", 1, listOf("4800000000031"), listOf(BarcodeUnit("4800000000031", "CS", null)))
    private val products = listOf(juice, chunks, noCaseSize)

    @Test fun pieceBarcodeAddsOnePiece() {
        val a = ScanRules.resolve("4800000000017", products, SellingPlace.VAN) as ScanAction.Add
        assertEquals("p1", a.product.productId); assertEquals(1L, a.baseQuantity); assertFalse(a.isCase)
    }
    @Test fun caseBarcodeAddsOneCase() {
        val a = ScanRules.resolve("14800000000014", products, SellingPlace.STORE) as ScanAction.Add
        assertEquals(12L, a.baseQuantity); assertTrue(a.isCase); assertEquals("CS", a.unitLabel)
    }
    @Test fun aBarcodeWithNoUnitRecordedIsOnePiece() {
        val a = ScanRules.resolve("4800000000024", products, SellingPlace.VAN) as ScanAction.Add
        assertEquals(1L, a.baseQuantity)
    }
    @Test fun aProductCodeIsOnePiece() {
        val a = ScanRules.resolve("SP-PJ-1L", products, SellingPlace.VAN) as ScanAction.Add
        assertEquals("p1", a.product.productId); assertEquals(1L, a.baseQuantity)
    }
    @Test fun anUnknownCodeIsAPlainRefusalNamingThePlace() {
        assertEquals("Not in this van: 9999999999994", (ScanRules.resolve("9999999999994", products, SellingPlace.VAN) as ScanAction.Refuse).message)
        assertEquals("Not in this store: 9999999999994", (ScanRules.resolve("9999999999994\r\n", products, SellingPlace.STORE) as ScanAction.Refuse).message)
    }
    @Test fun aCaseWithNoKnownSizeIsNeverGuessed() {
        val r = ScanRules.resolve("4800000000031", products, SellingPlace.VAN) as ScanAction.Refuse
        assertTrue(r.message, r.message.contains("case size not set"))
    }
    @Test fun aCodeOnTwoProductsIsNotGuessed() {
        val twin = chunks.copy(productId = "p9", code = "SP-TWIN", barcodes = listOf("4800000000017"))
        val r = ScanRules.resolve("4800000000017", listOf(juice, twin), SellingPlace.VAN) as ScanAction.Refuse
        assertTrue(r.message.contains("2 products"))
    }

    @Test fun addingStopsAtTheStockOnHandAndNamesWhatIsLeft() {
        var lines = emptyList<CartLine>()
        (1..3).forEach { lines = (SellingCart.add(lines, chunks, 1, 3) as AddOutcome.Added).lines }
        assertEquals(3L, SellingCart.baseOf(lines, "p2"))
        val over = SellingCart.add(lines, chunks, 1, 3) as AddOutcome.OnlyLeft
        assertEquals("0 PC", over.leftLabel)
        assertEquals("Only 0 PC left of Pineapple Chunks 432g.", SellingCart.refusalText(over))
    }
    @Test fun zeroStockIsBlocked() {
        val r = SellingCart.add(emptyList(), juice, 1, 0)
        assertEquals(AddOutcome.OutOfStock("Pineapple Juice 1L"), r)
        assertEquals("Pineapple Juice 1L is out of stock.", SellingCart.refusalText(r))
    }
    @Test fun aCaseScanWithTooLittleStockIsRefusedWithPiecesLeft() {
        val r = SellingCart.add(emptyList(), juice, 12, 7) as AddOutcome.OnlyLeft
        assertEquals("7 PC", r.leftLabel)
    }
    @Test fun typedQuantityZeroRemovesAndTooMuchIsRefused() {
        val lines = listOf(CartLine("p1", 5))
        assertTrue((SellingCart.setQuantity(lines, juice, 0, 20) as AddOutcome.Added).lines.isEmpty())
        assertTrue(SellingCart.setQuantity(lines, juice, 21, 20) is AddOutcome.OnlyLeft)
        assertEquals(9L, SellingCart.baseOf((SellingCart.setQuantity(lines, juice, 9, 20) as AddOutcome.Added).lines, "p1"))
    }
    @Test fun oneLinePerProduct() {
        var lines = emptyList<CartLine>()
        lines = (SellingCart.add(lines, juice, 1, 50) as AddOutcome.Added).lines
        lines = (SellingCart.add(lines, juice, 12, 50) as AddOutcome.Added).lines
        assertEquals(1, lines.size); assertEquals(13L, lines.single().quantityBase)
    }

    @Test fun casesAndPiecesAreShownTogether() {
        assertEquals("1 CS + 3 PC", Quantities.label(juice, 15))
        assertEquals("2 CS", Quantities.label(juice, 24))
        assertEquals("5 PC", Quantities.label(juice, 5))
        assertEquals("5 PC", Quantities.label(chunks, 5))
        assertEquals(12L, Quantities.casePack(juice)?.perCaseBase)
        assertNull(Quantities.casePack(noCaseSize))
    }
    @Test fun categoryFallsBackToTheFirstWordOfTheName() {
        assertEquals("Pineapple", Quantities.category(juice))
        assertEquals("Frozen", Quantities.category(juice.copy(category = " Frozen ")))
    }

    @Test fun quickCashRoundsUpAboveTheTotal() {
        assertEquals(listOf(4000L, 5000L, 10000L, 20000L, 50000L, 100000L), QuickCash.choices(2786))
        assertEquals(listOf(124000L, 125000L, 130000L, 140000L, 150000L, 200000L), QuickCash.choices(123_400))
        assertEquals(listOf(20000L, 50000L, 100000L), QuickCash.choices(10_000))
        assertTrue(QuickCash.choices(2786).all { it > 2786 })
    }
    @Test fun changeAndShortAreLive() {
        assertEquals(7214L, QuickCash.changeMinor(2786, 10_000))
        assertEquals(0L, QuickCash.changeMinor(2786, 2000)); assertEquals(786L, QuickCash.shortMinor(2786, 2000))
        assertTrue(QuickCash.canPay(2786, 2786)); assertFalse(QuickCash.canPay(2786, 2785)); assertFalse(QuickCash.canPay(2786, null))
        assertEquals("₱1,234.50", Peso.format(123_450))
    }

    @Test fun productDecodeKeepsAnOptionalCategoryAndOldCatalogueRowsHaveNone() {
        fun row(extra: org.json.JSONObject.() -> Unit) = org.json.JSONObject().put("productId", "p").put("code", "C-1").put("name", "Pineapple Juice").put("uomCode", "PC")
            .put("quantityScale", "1").put("barcodes", org.json.JSONArray()).apply(extra)
        assertEquals("Frozen", com.sunpride.van.sync.VanBootstrapCodec.product(row { put("category", " Frozen ") }).category)
        assertNull(com.sunpride.van.sync.VanBootstrapCodec.product(row { }).category)
        assertNull(com.sunpride.van.sync.VanBootstrapCodec.product(row { put("category", org.json.JSONObject.NULL) }).category)
    }

    // Beta.28: EXACT after picking a bill left TENDERED at the bill. EXACT always means tendered = what is due, change 0.
    @Test fun exactReplacesAPreviouslyPickedBillWithTheAmountDue() {
        val due = 4790L
        val pickedBill = QuickCash.choices(due).first { it == 20_000L }
        assertEquals(15_210L, QuickCash.changeMinor(due, pickedBill))
        val afterExact = QuickCash.exactTenderedMinor(due)
        assertEquals(due, afterExact)
        assertEquals(0L, QuickCash.changeMinor(due, afterExact))
        assertEquals(0L, QuickCash.shortMinor(due, afterExact))
        assertTrue(QuickCash.canPay(due, afterExact))
    }
}
