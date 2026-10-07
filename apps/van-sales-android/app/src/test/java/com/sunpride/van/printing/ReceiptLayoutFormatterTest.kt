package com.sunpride.van.printing

import org.junit.Assert.*
import org.junit.Test

class ReceiptLayoutFormatterTest {
    private val formatter = ReceiptLayoutFormatter()
    @Test fun wrapsWordsAndNeverLosesCharacters() {
        val input = "TEST RECEIPT - NOT AN OFFICIAL RECEIPT " + "0123456789".repeat(10)
        val lines = formatter.wrap(input)
        assertTrue(lines.all { it.length <= 32 })
        assertEquals(input, lines.joinToString(""))
    }
    @Test fun keepsExplicitNewlinesAndEmptyLines() {
        assertEquals(listOf("one", "", "two", ""), formatter.wrap("one\n\ntwo\n"))
    }
    @Test fun columnsPutAmountAtRightEdgeAndWrapLabel() {
        val lines = formatter.columnLines("A long description for a sample frozen food product", "P123.45")
        assertTrue(lines.size > 1)
        assertTrue(lines.all { it.length <= 32 })
        assertEquals(32, lines.last().length)
        assertTrue(lines.last().endsWith("P123.45"))
        assertEquals("TOTAL                     P10.00", formatter.columnLines("TOTAL", "P10.00").single())
    }
    @Test fun oversizedValueAndLabelAreNotSilentlyTruncated() {
        val label = "Frozen ham " + "x".repeat(60)
        val amount = "P" + "9".repeat(60) + ".00"
        val lines = formatter.columnLines(label, amount)
        assertTrue(lines.all { it.length <= 32 })
        assertEquals(label.replace(" ", "") + amount, lines.joinToString("").replace(" ", ""))
    }
    @Test fun doubleWidthWrapsToSixteenCellsAndKeepsStyle() {
        val style = ReceiptStyle(bold = true, doubleWidth = true, doubleHeight = true)
        val commands = formatter.format(ReceiptDocument(listOf(ReceiptElement.Text("a".repeat(45), style))))
            .filterIsInstance<ReceiptCommand.Line>()
        assertTrue(commands.all { it.text.length <= 16 && it.style == style })
        assertEquals(45, commands.sumOf { it.text.length })
    }
    @Test fun surrogatePairIsNotSplit() {
        val text = "😀".repeat(40)
        val lines = formatter.wrap(text)
        assertEquals(text, lines.joinToString(""))
        assertTrue(lines.all { it.codePointCount(0, it.length) <= 32 })
        assertEquals(2, lines.size)
    }
    @Test fun reprintBannerAndDividerAre32CellSafe() {
        val lines = formatter.format(ReceiptDocument(listOf(ReceiptElement.Divider()), true)).filterIsInstance<ReceiptCommand.Line>()
        assertEquals("REPRINT", lines[0].text)
        assertEquals("-".repeat(32), lines[1].text)
    }
}
