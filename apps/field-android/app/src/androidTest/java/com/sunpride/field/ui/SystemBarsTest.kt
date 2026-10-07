package com.sunpride.field.ui

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import kotlin.math.abs

/** SP-0090: the navigation bar (3-button or gesture) shows the app's own background, in both themes. */
class SystemBarsTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test fun darkThemeNavigationBarMatchesTheDarkBackground() = check(dark = true)
    @Test fun lightThemeNavigationBarMatchesTheLightBackground() = check(dark = false)

    private fun check(dark: Boolean) {
        val background = (if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors).background
        rule.runOnUiThread { rule.activity.applySystemBars(dark) }
        rule.setContent { Box(Modifier.fillMaxSize().background(background)) }
        rule.waitForIdle()
        val window = rule.activity.window
        val decor = window.decorView
        var bottom = 0
        rule.runOnUiThread {
            val controller = WindowCompat.getInsetsController(window, decor)
            // Icons contrast with the bar: dark icons on the light theme, light icons on the dark one.
            assertEquals(!dark, controller.isAppearanceLightNavigationBars)
            assertEquals(!dark, controller.isAppearanceLightStatusBars)
            // No system scrim over the bar: that scrim is the light-gray bar under the dark theme.
            assertFalse(window.isNavigationBarContrastEnforced)
            bottom = ViewCompat.getRootWindowInsets(decor)!!.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom
        }
        assertTrue("navigation bar must sit at the bottom of the screen", bottom > 0)
        Thread.sleep(400) // let the system bars redraw before the screenshot
        val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
        try {
            // Sample the bar's left edge, clear of the Back/Home/Recents glyphs and the gesture handle.
            val y = shot.height - bottom / 2
            val pixel = shot.getPixel(4, y)
            val expected = background.toArgb()
            fun channel(color: Int, shift: Int) = (color shr shift) and 0xFF
            val off = listOf(16, 8, 0).maxOf { abs(channel(pixel, it) - channel(expected, it)) }
            assertTrue("navigation bar pixel #%06X differs from theme background #%06X"
                .format(pixel and 0xFFFFFF, expected and 0xFFFFFF), off <= 8)
        } finally { shot.recycle() }
    }
}
