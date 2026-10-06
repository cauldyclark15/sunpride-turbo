package com.sunpride.field

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.sunpride.field.auth.KeystoreSessionVault
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.DeviceKeyInfo
import com.sunpride.field.ui.FieldApp
import com.sunpride.field.ui.LiveFieldBackend
import com.sunpride.field.ui.applySystemBars
import java.io.File

class MainActivity : ComponentActivity() {
    // SP-0124: visits, orders, call sheet and photos are product features in every build (beta included);
    // only DEV debug builds add the developer tools. See docs/BETA_FEATURES.md.
    private val features = FieldFeatures.forBuild(BuildConfig.FLAVOR, BuildConfig.DEBUG, BuildConfig.WEB_URL)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        com.sunpride.field.diagnostics.CrashBreadcrumbs.install(applicationContext)
        val environment = AppEnvironment(BuildConfig.CONVEX_SITE_URL, BuildConfig.CONVEX_URL)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        applySystemBars(dark)
        val app = applicationContext
        val backend = LiveFieldBackend(environment, KeystoreSessionVault(app), app) { KeystoreDeviceKey.loadOrCreate(app) }
        setContent {
            FieldApp(environment, dark = dark, backend = backend, features = features,
                onKeyLoaded = { exportPublicKeyForDev(it) })
        }
    }

    /**
     * DEV debug builds only: write the PUBLIC key (never private material or tokens) to
     * `/sdcard/Android/data/com.sunpride.field.dev/files/device-public-key.txt` for `adb pull`.
     */
    private fun exportPublicKeyForDev(key: DeviceKeyInfo) {
        if (FieldFeature.DEVELOPER_TOOLS !in features) return
        val dir = getExternalFilesDir(null) ?: return
        File(dir, PUBLIC_KEY_FILE).writeText(key.publicKey + "\n")
    }

    companion object { const val PUBLIC_KEY_FILE = "device-public-key.txt" }
}
