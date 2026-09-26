package com.sunpride.field

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import com.sunpride.field.auth.KeystoreSessionVault
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.DeviceKeyInfo
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.LiveFieldBackend
import java.io.File

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val environment = AppEnvironment(BuildConfig.CONVEX_SITE_URL, BuildConfig.CONVEX_URL)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightStatusBars = !dark
        val app = applicationContext
        val backend = LiveFieldBackend(environment, KeystoreSessionVault(app), app) { KeystoreDeviceKey.loadOrCreate(app) }
        setContent {
            FieldApp(environment, dark = dark, debug = BuildConfig.DEBUG && BuildConfig.FLAVOR == "dev", backend = backend,
                onKeyLoaded = { exportPublicKeyForDev(it) })
        }
    }

    /**
     * DEV debug builds only: write the PUBLIC key (never private material or tokens) to
     * `/sdcard/Android/data/com.sunpride.field.dev/files/device-public-key.txt` for `adb pull`.
     */
    private fun exportPublicKeyForDev(key: DeviceKeyInfo) {
        if (!(BuildConfig.DEBUG && BuildConfig.FLAVOR == "dev")) return
        val dir = getExternalFilesDir(null) ?: return
        File(dir, PUBLIC_KEY_FILE).writeText(key.publicKey + "\n")
    }

    companion object { const val PUBLIC_KEY_FILE = "device-public-key.txt" }
}
