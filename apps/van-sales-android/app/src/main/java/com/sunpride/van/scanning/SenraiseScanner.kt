package com.sunpride.van.scanning

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import com.sunpride.van.printing.SenraiseEmbeddedPrinter

/** No scan-trigger API is assumed: the H10P's physical button is owned by the vendor service.
 * Register only while the scan/sale screen is visible. Broadcasts are untrusted product input,
 * never authorization or a sale command. The vendor broadcast has no signature permission.
 */
class SenraiseScanner(context: Context, val inputs: BarcodeInputs = BarcodeInputs()) : BarcodeSource, AutoCloseable {
    private val context = context.applicationContext
    override val scans = inputs.scans
    private var registered = false
    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == ACTION) {
                runCatching { intent.getStringExtra(RESULT_EXTRA) }.getOrNull()
                    ?.let { inputs.submit(it, ScanSource.BROADCAST) }
            }
        }
    }
    @Suppress("UnspecifiedRegisterReceiverFlag")
    @Synchronized fun start() {
        if (registered) return
        val filter = IntentFilter(ACTION)
        if (Build.VERSION.SDK_INT >= 33) {
            context.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            context.registerReceiver(receiver, filter)
        }
        registered = true
    }
    @Synchronized fun stop() {
        if (registered) {
            context.unregisterReceiver(receiver)
            registered = false
        }
        inputs.resetWedge()
    }
    /** Call after connecting the printer; null means availability could not be queried. */
    suspend fun queryScannerStatus(printer: SenraiseEmbeddedPrinter): Boolean? = printer.scannerStatus()
    override fun close() = stop()
    companion object {
        const val ACTION = "android.scanner.scan"
        const val RESULT_EXTRA = "result"
    }
}
