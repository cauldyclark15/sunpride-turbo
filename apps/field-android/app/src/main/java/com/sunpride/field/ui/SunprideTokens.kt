package com.sunpride.field.ui

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
    val muted = Color(0xFF626269)
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
    // Field v2 (sibling of the handheld POS look): soft 12/16/20 dp corners, pills for chips and buttons.
    val shapes = Shapes(
        extraSmall = RoundedCornerShape(14.dp),
        small = RoundedCornerShape(12.dp),
        medium = RoundedCornerShape(20.dp),
        large = RoundedCornerShape(20.dp),
        extraLarge = RoundedCornerShape(28.dp)
    )
    // One scale, sp so it follows the phone's font size. Body never below 13 sp, labels never below 12 sp:
    // sellers read this outdoors. Weights carry the hierarchy, not extra sizes.
    val typography = Typography(
        headlineMedium = TextStyle(fontSize = 28.sp, lineHeight = 34.sp, fontWeight = FontWeight.Bold),
        headlineSmall = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold),
        titleLarge = TextStyle(fontSize = 22.sp, lineHeight = 28.sp, fontWeight = FontWeight.Bold),
        titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.SemiBold),
        titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
        bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 24.sp),
        bodyMedium = TextStyle(fontSize = 14.sp, lineHeight = 20.sp),
        bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp),
        labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold),
        labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold),
        labelSmall = TextStyle(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium)
    )
    /** Cards sit one step off the white sheet (POS look): FAFAFA with a hairline. */
    val cardLight = Color(0xFFFAFAFA)
    val hairlineLight = Color(0xFFD9D9DE)
    val tintLight = Color(0xFFFCE9E7)
    val onTintLight = Color(0xFF8E1117)
    val lightColors = lightColorScheme(
        primary = accessibleRed, onPrimary = snow,
        primaryContainer = tintLight, onPrimaryContainer = onTintLight,
        secondary = ink, onSecondary = snow,
        secondaryContainer = tintLight, onSecondaryContainer = onTintLight,
        background = Color.White, onBackground = ink,
        surface = cardLight, onSurface = ink,
        surfaceVariant = disabledLight, onSurfaceVariant = muted,
        surfaceContainer = Color.White, surfaceContainerHigh = Color.White,
        error = danger, onError = snow,
        outline = muted, outlineVariant = hairlineLight
    )
    val darkColors = darkColorScheme(
        primary = darkAccent, onPrimary = ink,
        primaryContainer = Color(0xFF3A2220), onPrimaryContainer = Color(0xFFFFDAD6),
        secondary = yellow, onSecondary = ink,
        secondaryContainer = Color(0xFF3A2220), onSecondaryContainer = Color(0xFFFFDAD6),
        background = darkCanvas, onBackground = snow,
        surface = darkSurface, onSurface = snow,
        surfaceVariant = disabledDark, onSurfaceVariant = snow,
        surfaceContainer = darkCanvas, surfaceContainerHigh = darkSurface,
        error = darkDanger, onError = ink,
        outline = darkMuted, outlineVariant = Color(0xFF4A4A4A)
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
