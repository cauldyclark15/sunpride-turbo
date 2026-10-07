package com.sunpride.field.ui

import android.graphics.Color
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge

/**
 * Draw the app behind transparent status and navigation bars, with icons that suit the theme.
 *
 * Android 15+ (targetSdk 35+) always lays the app out edge to edge and, by default, puts a
 * scrim behind the 3-button navigation bar that follows the window theme (a light gray bar
 * under the dark app). A fixed light/dark style turns that scrim off, so the Scaffold's
 * background shows through and the bar matches the theme; the Scaffold content insets keep
 * every screen above it.
 */
fun ComponentActivity.applySystemBars(dark: Boolean) {
    val style = if (dark) SystemBarStyle.dark(Color.TRANSPARENT)
    else SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT)
    enableEdgeToEdge(statusBarStyle = style, navigationBarStyle = style)
}
