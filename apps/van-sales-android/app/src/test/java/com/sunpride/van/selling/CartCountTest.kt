package com.sunpride.van.selling

import com.sunpride.van.data.BarcodeUnit
import com.sunpride.van.data.Product
import com.sunpride.van.pos.CartLine
import org.junit.Assert.assertEquals
import org.junit.Test

class CartCountTest {
    private val soap = Product("p1", "SOAP", "Soap", "PC", 1000, listOf("1"), listOf(BarcodeUnit("2", "CS", 24_000)))
    private val gum = Product("p2", "GUM", "Gum", "PC", 1000, listOf("3"))
    private val byId = mapOf("p1" to soap, "p2" to gum)
    private fun label(vararg l: CartLine) = CartCount.label(l.toList()) { byId[it] }

    @Test fun twoProductsThreePieces() = assertEquals("2 products · 3 pcs", label(CartLine("p1", 2000), CartLine("p2", 1000)))
    @Test fun onePieceIsSingular() = assertEquals("1 product · 1 pc", label(CartLine("p2", 1000)))
    @Test fun oneCase() = assertEquals("1 product · 1 case", label(CartLine("p1", 24_000)))
    @Test fun casesAndPieces() = assertEquals("2 products · 2 cases + 4 pcs", label(CartLine("p1", 49_000), CartLine("p2", 3000)))
    @Test fun emptyCart() = assertEquals("0 products", label())
    @Test fun zeroLinesAreNotCounted() = assertEquals("1 product · 1 pc", label(CartLine("p2", 1000), CartLine("p1", 0)))
    @Test fun unknownProductCountsBase() = assertEquals("1 product · 5 pcs", CartCount.label(listOf(CartLine("zz", 5)).toList()) { null })
}
