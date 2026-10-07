package com.sunpride.van.printing

import android.content.Context
import android.content.pm.PackageManager
import com.sunpride.van.printing.escpos.BluetoothPrinters

object PrinterRegistry {
    /**
     * VAN-015: a Bluetooth ESC/POS printer the seller explicitly chose wins; otherwise the H10P built-in
     * printer when its service exists; otherwise [NoPrinter]. Never a silently successful fake.
     */
    fun select(context: Context): SelectablePrinter {
        val app = context.applicationContext
        return SelectablePrinter(SharedPrefsPrinterChoiceStore(app)) { choice ->
            when {
                choice != null -> BluetoothPrinters.printer(app, choice)
                hasSenraiseService(app) -> SenraiseEmbeddedPrinter(app)
                else -> NoPrinter()
            }
        }
    }
    @Suppress("DEPRECATION")
    fun hasSenraiseService(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(SenraiseEmbeddedPrinter.PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) { false }
}
