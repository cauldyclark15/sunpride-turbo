package com.sunpride.van.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.*
import org.junit.Test

/** IP-HH1 outdoor theme: text on every selling surface keeps at least 7:1 (WCAG AAA), so it reads in direct sun. */
class SellingThemeTest {
    private fun assertAaa(name: String, fg: Color, bg: Color) = assertTrue("$name ${contrastRatio(fg, bg)}", contrastRatio(fg, bg) >= 7.0)

    @Test fun stockBadgesAndToastsAreReadable() {
        assertAaa("in stock", Color.White, SunprideTokens.stockGreen)
        assertAaa("empty", Color.White, SunprideTokens.emptyRed)
    }
    @Test fun cartBarTotalAndChargeButton() {
        assertAaa("total on bar", SunprideTokens.barYellow, SunprideTokens.barInk)
        assertAaa("bar text", SunprideTokens.barText, SunprideTokens.barInk)
        assertAaa("charge", Color.Black, SunprideTokens.barYellow)
    }
    @Test fun secondaryTextOnWhiteAndCanvasIsNotThinGrey() {
        assertAaa("muted on white", SunprideTokens.muted, SunprideTokens.surface)
        assertAaa("muted on canvas", SunprideTokens.muted, SunprideTokens.canvas)
        assertAaa("ink on canvas", SunprideTokens.ink, SunprideTokens.canvas)
    }
    @Test fun redActionsAndTotalsOnWhite() {
        assertAaa("accessible red button", Color.White, SunprideTokens.accessibleRed)
        assertAaa("red line total on white", SunprideTokens.emptyRed, SunprideTokens.surface)
    }
    @Test fun totalsAreBigAndBodyTextIsNotSmall() {
        assertTrue(SunprideTokens.typography.headlineLarge.fontSize.value >= 44f)
        assertTrue(SunprideTokens.typography.bodyMedium.fontSize.value >= 15f)
        assertTrue(SunprideTokens.typography.bodyLarge.fontSize.value >= 17f)
    }
    @Test fun highlightMarksEveryTypedWordCaseInsensitively() {
        val h = highlight("Pineapple Juice 1L", "juice pine")
        val marked = h.spanStyles.map { h.text.substring(it.start, it.end) }
        assertEquals(listOf("Pine", "Juice"), marked)
        assertEquals(0, highlight("Pineapple", "").spanStyles.size)
    }
}
