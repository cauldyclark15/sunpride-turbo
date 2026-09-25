package com.sunpride.field

import android.content.res.Configuration
import android.os.Bundle
import androidx.core.view.WindowCompat
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.sunpride.field.ui.FieldApp

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val environment = AppEnvironment(BuildConfig.CONVEX_SITE_URL, BuildConfig.CONVEX_URL)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = !dark
        setContent {
            FieldApp(environment, dark = dark, debug = BuildConfig.DEBUG)
        }
    }
}
