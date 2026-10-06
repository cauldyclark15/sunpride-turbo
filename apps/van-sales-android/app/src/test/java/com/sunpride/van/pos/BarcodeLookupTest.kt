package com.sunpride.van.pos

import com.sunpride.van.data.BarcodeUnit
import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import org.junit.Assert.*
import org.junit.Test

/** VAN-009: scans resolve offline to product AND unit, with explicit not-found and ambiguous results. */
class BarcodeLookupTest {
    private val juice = Product("p1","SP-PJ-1L","Pineapple Juice 1L","PC",1,listOf("4800000000017","14800000000016","4800000000031"),
        listOf(BarcodeUnit("4800000000017","PC",1),BarcodeUnit("14800000000016","CS",24),BarcodeUnit("4800000000031","TRAY",null)))
    private val upc = Product("p2","SP-UPC","Imported Syrup","PC",1000,listOf("012345678905"),listOf(BarcodeUnit("012345678905","PC",1000)))
    private val legacy = Product("p3","SP-OLD","Legacy cache item","PC",1,listOf("4800000000048"))
    private val products = listOf(juice,upc,legacy)
    private val lookup = BarcodeLookup(products)

    @Test fun exactBarcodeResolvesTheSellingUnit() {
        val hit = lookup.resolve("4800000000017").single()
        assertEquals("p1",hit.product.productId); assertEquals(ScanMatch.BARCODE,hit.match)
        assertEquals(ScanUnit("PC",1),hit.unit); assertTrue(hit.isSellingUnit); assertEquals("PC",hit.unitLabel())
    }

    @Test fun caseBarcodeResolvesTheCaseAndItsBaseQuantity() {
        val hit = lookup.resolve("14800000000016").single()
        assertEquals(ScanUnit("CS",24),hit.unit); assertFalse(hit.isSellingUnit)
        assertEquals("CS · 24 PC",hit.unitLabel())
    }

    @Test fun unitWithoutConversionIsNamedButNoQuantityIsGuessed() {
        val hit = lookup.resolve("4800000000031").single()
        assertEquals("TRAY",hit.unit.uomCode); assertNull(hit.unit.baseQuantity); assertFalse(hit.unit.quantityKnown)
        assertEquals("TRAY · no conversion to PC",hit.unitLabel())
    }

    @Test fun cacheWithoutBarcodeUnitsDoesNotAssumeTheSellingUnit() {
        val hit = lookup.resolve("4800000000048").single()
        assertEquals(ScanUnit(null,null),hit.unit); assertFalse(hit.unit.quantityKnown)
        assertEquals("Unit not confirmed by the office",hit.unitLabel())
    }

    @Test fun scannerSuffixesAndAimPrefixesAreRemoved() {
        assertEquals("p1",lookup.resolve("4800000000017\r\n").single().product.productId)
        assertEquals("p1",lookup.resolve("]E04800000000017").single().product.productId)
    }

    @Test fun sameGtinInAnotherLengthMatches() {
        // A scanner sending UPC-A as EAN-13 (leading 0) or as GTIN-14 still finds the product.
        val ean13 = lookup.resolve("0012345678905").single()
        assertEquals("p2",ean13.product.productId); assertEquals(ScanMatch.GTIN,ean13.match); assertEquals(ScanUnit("PC",1000),ean13.unit)
        assertEquals("p2",lookup.resolve("00012345678905").single().product.productId)
        assertEquals("p1",lookup.resolve("04800000000017").single().product.productId)
    }

    @Test fun gs1ElementStringWithAi01AndValidCheckDigitMatches() {
        val hit = lookup.resolve("(01)14800000000016(17)271231(10)LOT7").single()
        assertEquals(ScanMatch.GS1,hit.match); assertEquals("CS",hit.unit.uomCode)
        assertEquals("p1",lookup.resolve("01148000000000161727123110LOT7").single().product.productId)
        assertTrue("bad check digit is not trusted",lookup.resolve("0114800000000015").isEmpty())
    }

    @Test fun exactProductCodeMatchesLast() {
        val hit = lookup.resolve("sp-pj-1l").single()
        assertEquals(ScanMatch.PRODUCT_CODE,hit.match); assertEquals(ScanUnit("PC",1),hit.unit)
    }

    @Test fun unknownCodesAreNotFoundNotGuessed() {
        assertTrue(lookup.resolve("0000000000000").isEmpty())
        assertTrue(lookup.resolve("480000000001").isEmpty()) // a prefix is never a scan match
        assertTrue(lookup.resolve(" 4800000000017").isEmpty()) // identifier spaces are not trimmed
        assertTrue(lookup.resolve("").isEmpty())
    }

    @Test fun barcodeOnSeveralProductsReturnsEveryCandidate() {
        val twin = Product("p9","SP-TWIN","Twin","PC",1,listOf("4800000000017"),listOf(BarcodeUnit("4800000000017","PC",1)))
        val both = BarcodeLookup(products + twin).resolve("4800000000017")
        assertEquals(setOf("p1","p9"),both.map { it.product.productId }.toSet())
    }

    @Test fun exactMatchWinsOverWeakerEvidence() {
        // A product whose CODE equals another product's barcode: the barcode wins, the code is not mixed in.
        val codeClash = Product("p8","4800000000017","Clash","PC",1,emptyList())
        val hits = BarcodeLookup(products + codeClash).resolve("4800000000017")
        assertEquals(listOf("p1"),hits.map { it.product.productId })
    }

    @Test fun checkDigit() {
        assertTrue(BarcodeKeys.checkDigitValid("4800000000019"))
        assertTrue(BarcodeKeys.checkDigitValid("14800000000016"))
        assertFalse("the demo fixture code is not a real GTIN",BarcodeKeys.checkDigitValid("4800000000017"))
        assertTrue(BarcodeKeys.checkDigitValid("012345678905"))
        assertFalse(BarcodeKeys.checkDigitValid("4800000000018"))
        assertFalse(BarcodeKeys.checkDigitValid("48000"))
    }

    @Test fun productSearchResolvesScansIntoRowsWithStockAndUnit() {
        val search = ProductSearch(products,listOf(TruckStock("p1",72,0)),emptyList<PriceLine>(),0)
        val scan = search.resolveScan("14800000000016").single()
        assertEquals(72L,scan.hit.availableBase); assertEquals("CS",scan.candidate.unit.uomCode)
        assertEquals("p2",search.byBarcode("0012345678905")?.product?.productId)
        // A typed GTIN in another length ranks the product as a barcode match too.
        assertEquals(MatchKind.BARCODE,search.search("0012345678905").first().match)
    }
}
