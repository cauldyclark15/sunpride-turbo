package com.sunpride.van

import android.content.res.Configuration
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.sunpride.van.data.VanRepository
import com.sunpride.van.device.KeystoreDeviceKey
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.ui.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private var repository: VanRepository? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        applySystemBars(dark)
        val environment = AppEnvironment(BuildConfig.CONVEX_SITE_URL,BuildConfig.CONVEX_URL)
        val mode = if (BuildConfig.DEBUG) intent.getStringExtra(VanRepository.STUB_EXTRA)?.takeIf { it in setOf("ready","unregistered","revoked") } else null
        val repo = VanRepository.create(applicationContext,stubMode = mode,environment = environment).also { repository = it }
        val controller = VanController(repo,environment,fixtureMode = mode != null) {
            withContext(Dispatchers.IO) {
                val alias = if (mode != null) "sunpride-van-stub-device-p256-v1" else KeystoreDeviceKey.DEFAULT_ALIAS
                hex(sha256(KeystoreDeviceKey.loadOrCreate(applicationContext,alias).publicKeySpki)).uppercase().chunked(4).joinToString(" ")
            }
        }
        setContent { VanApp(controller,dark) }
    }
    override fun onDestroy() {
        super.onDestroy()
        repository?.close(); repository = null
    }
}
