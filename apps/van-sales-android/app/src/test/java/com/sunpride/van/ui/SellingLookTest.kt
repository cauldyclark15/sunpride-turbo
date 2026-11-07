package com.sunpride.van.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.*
import org.junit.Test

/** IP-LOOK: the BELION look keeps the IP-HH1 outdoor rules: text >= 4.5:1 (primary numbers >= 7:1), amounts shrink instead of clipping. */
class SellingLookTest {
    private fun atLeast(min: Double, name: String, fg: Color, bg: Color) = assertTrue("$name ${contrastRatio(fg, bg)}", contrastRatio(fg, bg) >= min)
    private val white = Color.White

    @Test fun headerAndSheetTitlesAreReadableOnTheRedGradient() {
        atLeast(4.5, "title on gradient start", white, Look.gradientStart)
        atLeast(4.5, "title on gradient end", white, Look.gradientEnd)
        atLeast(7.0, "button text on accent red", SunprideTokens.snow, SunprideTokens.accessibleRed)
    }

    @Test fun cardTextIsAtLeastSevenToOne() {
        for (bg in listOf(white, Look.cardLight)) {
            atLeast(7.0, "ink on $bg", SunprideTokens.ink, bg)
            atLeast(7.0, "muted on $bg", SunprideTokens.muted, bg)
            atLeast(7.0, "amber stock text on $bg", Look.amberText, bg)
            atLeast(7.0, "accent price sign on $bg", SunprideTokens.accessibleRed, bg)
            atLeast(7.0, "out of stock on $bg", SunprideTokens.emptyRed, bg)
        }
    }

    @Test fun addPillAndSelectedCouponTextOnTheTint() {
        atLeast(4.5, "accent on tint", SunprideTokens.accessibleRed, Look.tintLight)
        atLeast(7.0, "ink on tint", SunprideTokens.ink, Look.tintLight)
    }

    @Test fun cartBarAndChipsOnNearBlack() {
        atLeast(7.0, "total on bar", white, Look.barInk)
        atLeast(7.0, "summary on bar", Color(0xFFD4D4D8), Look.barInk)
        atLeast(7.0, "selected chip count", Color(0xFFFFD7D2), Look.barInk)
        atLeast(3.0, "charge disc against the bar", Look.gradientEnd, Look.barInk)
    }

    @Test fun productTilesKeepInkAndCategoryReadable() {
        tileTints.forEach { tile ->
            atLeast(7.0, "initials on $tile", Color(0xFF18181B), tile)
            atLeast(7.0, "category on $tile", Color(0xFF3F3F46), tile)
        }
    }

    @Test fun amountsShrinkToFitAndNeverBelowTheMinimum() {
        // Pretend every character is 0.6em wide: 13 chars at 44sp is 343px, so a 300px box needs a smaller size.
        val width = { sp: Float -> sp * 0.6f * 13 }
        val size = Look.fitFontSize(44f, 20f, 300f, width)
        assertTrue(width(size) <= 300f)
        assertTrue(size < 44f && size >= 20f)
        assertEquals(44f, Look.fitFontSize(44f, 20f, 400f, width), 0f)
        assertEquals(20f, Look.fitFontSize(44f, 20f, 10f, width), 0f)
    }

    @Test fun initialsFromNames() {
        assertEquals("HR", initialsOf("Hector Ramos"))
        assertEquals("SB", initialsOf("Sample Beef Burger Patties"))
        assertEquals("CA", initialsOf("calamansi"))
        assertEquals("?", initialsOf("  "))
    }
}
