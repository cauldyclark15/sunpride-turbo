package com.sunpride.van.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/** Semantic brand tokens from packages/ui/docs/DESIGN.md, not component literals. */
object SunprideTokens {
    val red = Color(0xFFEE1C25)
    val yellow = Color(0xFFFEF200)
    val success = Color(0xFF2E9D59)
    val danger = Color(0xFFC8102E)
    val ink = Color(0xFF18181B)
    val canvas = Color(0xFFF5F5F5)
    val surface = Color.White
    val snow = Color(0xFFFCFCFC)
    val muted = Color(0xFF3F3F46)
    val darkCanvas = Color(0xFF060606)
    val darkSurface = Color(0xFF181818)
    val darkMuted = Color(0xFFB4B4B4)
    val accessibleRed = Color(0xFFAB151C)
    val darkAccent = Color(0xFFFA7065)
    val darkDanger = Color(0xFFE476A0)
    val darkSuccess = Color(0xFF70B785)
    val disabledLight = Color(0xFFE1E1E2)
    val disabledDark = Color(0xFF343434)

    val spacing1 = 4.dp
    val spacing2 = 8.dp
    val spacing3 = 12.dp
    val spacing4 = 16.dp
    val spacing6 = 24.dp
    val spacing8 = 32.dp
    val shapes = Shapes(
        small = RoundedCornerShape(10.dp),
        medium = RoundedCornerShape(10.dp),
        large = RoundedCornerShape(16.dp)
    )
    // sp participates in the platform font scale; no unlicensed bundled font.
    // POS v2 type scale (sp, so it follows the system font size): 13 / 14 / 15 / 17 / 18 / 24 / 26 / 30 / 44. Roles, never per-screen sizes:
    // display = totals read at arm's length, headline = key figures, title = screen and card titles, body = reading, label = controls and captions.
    val typography = Typography(
        bodySmall = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 21.sp),
        bodyLarge = TextStyle(fontSize = 17.sp, lineHeight = 24.sp),
        labelSmall = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
        labelMedium = TextStyle(fontSize = 14.sp, lineHeight = 18.sp, fontWeight = FontWeight.SemiBold),
        labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Bold),
        titleMedium = TextStyle(fontSize = 18.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        titleLarge = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
        headlineSmall = TextStyle(fontSize = 26.sp, lineHeight = 32.sp, fontWeight = FontWeight.Bold),
        headlineMedium = TextStyle(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold),
        // IP-HH1 outdoor theme: totals are read at arm's length in direct sun.
        headlineLarge = TextStyle(fontSize = 44.sp, lineHeight = 50.sp, fontWeight = FontWeight.ExtraBold)
    )
    /** IP-HH1 selling palette: every pair is at least 7:1 (checked in SellingThemeTest), no thin grey on white. */
    val stockGreen = Color(0xFF0F5C33)
    val emptyRed = Color(0xFF9E1220)
    val barInk = Color(0xFF111111)
    val barYellow = Color(0xFFFEF200)
    val barText = Color(0xFFFFFFFF)
    val lightColors = lightColorScheme(
        primary = accessibleRed, onPrimary = snow,
        secondary = ink, onSecondary = snow,
        background = Color.White, onBackground = ink,
        surface = surface, onSurface = ink,
        surfaceVariant = disabledLight, onSurfaceVariant = muted,
        error = danger, onError = snow,
        outline = muted
    )
    val darkColors = darkColorScheme(
        primary = darkAccent, onPrimary = ink,
        secondary = yellow, onSecondary = ink,
        background = darkCanvas, onBackground = snow,
        surface = darkSurface, onSurface = snow,
        surfaceVariant = disabledDark, onSurfaceVariant = snow,
        error = darkDanger, onError = ink,
        outline = darkMuted
    )
}

/** WCAG relative luminance and contrast of opaque sRGB colors. */
fun contrastRatio(first: Color, second: Color): Double {
    fun luminance(color: Color): Double {
        fun channel(value: Float): Double {
            val c = value.toDouble()
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
    }
    val a = luminance(first)
    val b = luminance(second)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)
}
