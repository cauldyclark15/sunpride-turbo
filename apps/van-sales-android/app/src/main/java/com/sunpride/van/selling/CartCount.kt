package com.sunpride.van.selling

import com.sunpride.van.data.Product
import com.sunpride.van.pos.CartLine
import java.math.BigDecimal

/**
 * IP-LOOK polish: the words on the cart bar, "2 products · 3 pcs" or "1 product · 1 case". Display only: it reads the cart, it never
 * changes a quantity. Products are distinct cart lines; whole cases come from the product's own case size ([Quantities.casePack]) and
 * everything else is counted in pieces.
 */
object CartCount {
    data class Count(val products: Int, val cases: Long, val pieces: BigDecimal)

    fun count(lines: List<CartLine>, productOf: (String) -> Product?): Count {
        var products = 0
        var cases = 0L
        var pieces = BigDecimal.ZERO
        lines.filter { it.quantityBase > 0 }.forEach { line ->
            products++
            val product = productOf(line.productId)
            if (product == null || product.quantityScale <= 0) { pieces += BigDecimal(line.quantityBase); return@forEach }
            val (c, rest) = Quantities.split(product, line.quantityBase)
            cases += c
            pieces += BigDecimal.valueOf(rest).divide(BigDecimal.valueOf(product.quantityScale), java.math.MathContext.DECIMAL128)
        }
        return Count(products, cases, pieces)
    }

    private fun trim(n: BigDecimal): String = n.stripTrailingZeros().toPlainString()

    fun label(c: Count): String {
        val head = "${c.products} ${if (c.products == 1) "product" else "products"}"
        val parts = buildList {
            if (c.cases > 0) add("${c.cases} ${if (c.cases == 1L) "case" else "cases"}")
            if (c.pieces.signum() > 0) add("${trim(c.pieces)} ${if (c.pieces.compareTo(BigDecimal.ONE) == 0) "pc" else "pcs"}")
        }
        return if (parts.isEmpty()) head else head + " · " + parts.joinToString(" + ")
    }

    fun label(lines: List<CartLine>, productOf: (String) -> Product?): String = label(count(lines, productOf))
}
