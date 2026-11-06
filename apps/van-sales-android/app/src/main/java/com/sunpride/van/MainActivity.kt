package com.sunpride.van

import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.ui.graphics.toArgb
import com.sunpride.van.data.VanRepository
import com.sunpride.van.device.KeystoreDeviceKey
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.ui.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private var repository: VanRepository? = null
    private var printer: com.sunpride.van.printing.ReceiptPrinter? = null
    private var scanner: com.sunpride.van.scanning.ScannerInput? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        applySystemBars(dark)
        // The theme starts the window in logo red (splash, no white flash); the app background takes over now.
        window.setBackgroundDrawable(ColorDrawable((if (dark) SunprideTokens.darkColors else SunprideTokens.lightColors).background.toArgb()))
        val environment = AppEnvironment(BuildConfig.API_ORIGIN)
        val features = VanFeatures.forBuild(BuildConfig.DEBUG,BuildConfig.WEB_URL)
        val mode = if (BuildConfig.DEBUG && VanFeature.DEVELOPER_TOOLS in features)
            intent.getStringExtra(VanRepository.STUB_EXTRA)?.takeIf { it in setOf("ready","unregistered","revoked") } else null
        val repo = VanRepository.create(applicationContext,stubMode = mode,environment = environment).also { repository = it }
        // VAN-017: one printer for the Activity lifetime, shared by sale receipts and the printer check.
        val receiptPrinter = com.sunpride.van.printing.PrinterRegistry.select(applicationContext).also { printer = it }
        val controller = VanController(repo,environment,fixtureMode = mode != null,printer = receiptPrinter,features = features,
            locationSharing = com.sunpride.van.location.AndroidLocationSharing(applicationContext,stub = mode != null),
            publicKeyLoader = {
                withContext(Dispatchers.IO) {
                    val alias = if (mode != null) "sunpride-van-stub-device-p256-v1" else KeystoreDeviceKey.DEFAULT_ALIAS
                    KeystoreDeviceKey.loadOrCreate(applicationContext,alias).publicKeyBase64
                }
            }) {
            withContext(Dispatchers.IO) {
                val alias = if (mode != null) "sunpride-van-stub-device-p256-v1" else KeystoreDeviceKey.DEFAULT_ALIAS
                hex(sha256(KeystoreDeviceKey.loadOrCreate(applicationContext,alias).publicKeySpki)).uppercase().chunked(4).joinToString(" ")
            }
        }
        val scannerInput = com.sunpride.van.scanning.ScannerInput(applicationContext).also { scanner = it }
        setContent { VanApp(controller,dark,scannerInput = scannerInput) }
    }
    /** IP-HH1: keyboard-wedge bursts are taken here, before any text field, and only while the selling grid is on screen. */
    @android.annotation.SuppressLint("RestrictedApi")
    override fun dispatchKeyEvent(event: android.view.KeyEvent): Boolean = scanner?.onKeyEvent(event) == true || super.dispatchKeyEvent(event)
    override fun onDestroy() {
        super.onDestroy()
        repository?.close(); repository = null
        printer?.close(); printer = null
        scanner?.close(); scanner = null
    }
}
