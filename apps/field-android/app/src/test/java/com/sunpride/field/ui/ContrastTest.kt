package com.sunpride.field.ui

import org.junit.Assert.assertTrue
import org.junit.Test

class ContrastTest {
    @Test fun allTextBackgroundPairsMeetNormalTextThreshold() {
        val t = SunprideTokens
        val pairs = mapOf(
            "light shell" to (t.ink to t.canvas),
            "light surface" to (t.ink to t.surface),
            "light status" to (t.muted to t.disabledLight),
            "light action" to (t.snow to t.accessibleRed),
            "light error" to (t.danger to t.surface),
            "dark shell" to (t.snow to t.darkCanvas),
            "dark surface" to (t.snow to t.darkSurface),
            "dark status" to (t.snow to t.disabledDark),
            "dark action" to (t.ink to t.darkAccent),
            "dark error" to (t.darkDanger to t.darkSurface),
            "yellow swatch" to (t.ink to t.yellow),
            "success swatch" to (t.ink to t.success),
            "danger swatch" to (t.snow to t.danger)
        )
        pairs.forEach { (label, colors) ->
            val ratio = contrastRatio(colors.first, colors.second)
            assertTrue("$label: $ratio", ratio >= 4.5)
        }
    }
}
