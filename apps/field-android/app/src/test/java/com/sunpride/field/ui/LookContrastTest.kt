package com.sunpride.field.ui

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertTrue
import org.junit.Test

/** Field v2 look: every text/fill pair added by the redesign meets WCAG AA for normal text (4.5:1), in light and dark. */
class LookContrastTest {
    private fun check(label: String, fg: Color, bg: Color) {
        val ratio = contrastRatio(fg, bg)
        assertTrue("$label: $ratio", ratio >= 4.5)
    }

    @Test fun toneChipsAreReadableInBothThemes() {
        for (dark in listOf(false, true)) for (tone in Look.Tone.entries)
            check("$tone dark=$dark", Look.toneText(tone, dark), Look.toneFill(tone, dark))
    }

    @Test fun headerWhiteTextOnBothGradientEnds() {
        check("gradient start", Color.White, Look.gradientStart)
        check("gradient end", Color.White, Look.gradientEnd)
    }

    @Test fun floatingBarAndNavigationPairs() {
        val t = SunprideTokens
        check("floating bar", Color.White, Look.barInk)
        check("floating bar muted line (78%)", Color(0xFFC7C7C7), Look.barInk)
        check("start pill on bar", Color.White, Look.gradientEnd)
        check("nav selected icon on pill", t.onTintLight, t.tintLight)
        check("nav unselected label", t.muted, Color.White)
        check("muted on card", t.muted, t.cardLight)
        check("accent on tint", t.accessibleRed, t.tintLight)
        check("disabled button", t.muted, t.disabledLight)
        check("dark: muted on card", t.darkMuted, t.darkSurface)
    }
}
