package com.sunpride.van.ui

import com.sunpride.van.pos.StockCountLine
import com.sunpride.van.pos.StockLineSummary
import org.junit.Assert.assertEquals
import org.junit.Test

/** VAN-078: a disabled Save names the line that still needs a count or a reason. */
class StockCountMissingTest {
    private fun line(id: String, name: String, status: String, expected: Long) =
        StockLineSummary(id, "C-$id", name, "PC", 1, status, expected, null, null)
    private val lines = listOf(
        line("a", "Sample Fruit Cocktail", StockCountLine.AVAILABLE, 48), line("a", "Sample Fruit Cocktail", StockCountLine.DAMAGED, 0),
        line("b", "Sample Gulaman", StockCountLine.AVAILABLE, 10), line("b", "Sample Gulaman", StockCountLine.DAMAGED, 0))

    @Test fun namesUncountedLinesThenLinesMissingAReason() {
        val counts = mapOf(("a" to StockCountLine.AVAILABLE) to "48", ("b" to StockCountLine.AVAILABLE) to "9", ("b" to StockCountLine.DAMAGED) to "0")
        val missing = stockCountMissing(lines, counts, emptyMap(), setOf("sold_unrecorded"))
        assertEquals(listOf("Sample Fruit Cocktail · damaged count", "Sample Gulaman · sellable reason"), missing)
        assertEquals("Still to do: Sample Fruit Cocktail · damaged count and 1 more", stockMissingFooter(missing))
    }
    @Test fun everythingCountedAndExplainedLeavesNothing() {
        val counts = lines.associate { (it.productId to it.status) to it.expectedBase.toString() } + (("b" to StockCountLine.AVAILABLE) to "9")
        assertEquals(emptyList<String>(), stockCountMissing(lines, counts, mapOf(("b" to StockCountLine.AVAILABLE) to "sold_unrecorded"), setOf("sold_unrecorded")))
    }
}
