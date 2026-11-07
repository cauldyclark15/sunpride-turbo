package com.sunpride.van.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertTrue
import org.junit.Test

/** POS v2 colour pairs that are new or newly placed: text >= 4.5:1 everywhere, key figures >= 7:1 (outdoor use). */
class PosV2ContrastTest {
    private fun ratio(fg: Color, bg: Color) = contrastRatio(fg, bg)
    private fun atLeast(min: Double, fg: Color, bg: Color, what: String) = assertTrue("$what: ${"%.2f".format(ratio(fg, bg))}:1 < $min", ratio(fg, bg) >= min)

    @Test fun bottomBarLabelsAreReadable() {
        atLeast(4.5, SunprideTokens.accessibleRed, Look.tintLight, "selected tab label on the indicator tint")
        atLeast(4.5, SunprideTokens.accessibleRed, Color.White, "selected tab label on the bar")
        atLeast(4.5, SunprideTokens.muted, Color.White, "unselected tab label on the bar")
    }

    @Test fun optionTilesAndQuickCashAreReadable() {
        atLeast(7.0, SunprideTokens.accessibleRed, Look.cardLight, "selected EXACT / applied tile text on the card")
        atLeast(4.5, SunprideTokens.accessibleRed, Look.tintLight, "applied option tile label on its tint")
        atLeast(4.5, SunprideTokens.muted, Look.tintLight, "applied option detail on its tint")
        atLeast(4.5, Color.White, SunprideTokens.accessibleRed, "white on the selected quick-cash button / Complete")
    }

    @Test fun syncPillAndStockStateAreReadable() {
        atLeast(7.0, Color(0xFF18181B), Color.White, "sync pill text on white")
        atLeast(4.5, Look.amberText, Look.cardLight, "N left on the card")
        atLeast(4.5, SunprideTokens.emptyRed, Look.cardLight, "Sold out on the card")
        atLeast(4.5, Color.White, SunprideTokens.emptyRed, "badge text on the alert badge")
        atLeast(4.5, Color.White, SunprideTokens.stockGreen, "Open badge on green")
    }

    @Test fun cartBarAndNextStepCardKeepTheirText() {
        atLeast(7.0, Color.White, Look.barInk, "cart total on the dark bar")
        atLeast(7.0, Color(0xFFE6E6E8), Look.barInk, "next-step detail on the dark card")
    }
}
