package com.sunpride.van.printing

import android.content.Context
import android.content.pm.PackageManager

object PrinterRegistry {
    fun select(context: Context): ReceiptPrinter = if (hasSenraiseService(context)) {
        SenraiseEmbeddedPrinter(context.applicationContext)
    } else {
        // TODO(VAN-015): select an explicitly configured ESC/POS Bluetooth adapter here.
        NoPrinter()
    }
    @Suppress("DEPRECATION")
    fun hasSenraiseService(context: Context): Boolean = try {
        context.packageManager.getPackageInfo(SenraiseEmbeddedPrinter.PACKAGE, 0)
        true
    } catch (_: PackageManager.NameNotFoundException) { false }
}
