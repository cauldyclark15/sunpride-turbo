package com.sunpride.field.location

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings

/**
 * SP-0140: reads the phone's battery restriction for this app and opens the right settings page
 * (the brand's own page first, then Android's, then the app's details page, which always exists).
 * Call [view]/[shown]/[markShown] off the main thread (SharedPreferences first read hits storage).
 */
/**
 * SP-0207 (Google Play policy): the Android pages the battery guide may open, in order. Only settings screens that
 * need no permission — never Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS (which needs
 * REQUEST_IGNORE_BATTERY_OPTIMIZATIONS). The app's details page always exists, so it is last.
 */
object BatterySettings {
    fun actions(unrestricted: Boolean): List<String> = buildList {
        if (!unrestricted) add(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        add(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
    }
}

class AndroidBatteryGuide(context: Context) : BatteryGuideHost {
    private val app = context.applicationContext
    private val prefs by lazy { app.getSharedPreferences("battery_guide", Context.MODE_PRIVATE) }
    private val brand = BatteryGuideRules.brand(Build.MANUFACTURER, Build.BRAND)

    fun unrestricted(): Boolean = runCatching {
        (app.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(app.packageName)
    }.getOrDefault(false)

    override fun view(): BatteryGuideView = BatteryGuideView(brand, unrestricted(), BatteryGuideRules.hasAutostart(brand))
    fun shown(): Boolean = prefs.getBoolean(SHOWN, false)
    override fun markShown() { prefs.edit().putBoolean(SHOWN, true).apply() }
    override fun shouldShow(): Boolean = BatteryGuideRules.shouldShow(shown(), unrestricted(), brand)

    /** Opens the battery page from an Activity context; false when nothing could be opened. */
    override fun openBattery(activity: Context): Boolean = open(activity, buildList {
        if (brand in setOf("xiaomi", "redmi", "poco")) add(Intent().setComponent(ComponentName(
            "com.miui.powerkeeper", "com.miui.powerkeeper.ui.HiddenAppsConfigActivity"))
            .putExtra("package_name", app.packageName)
            .putExtra("package_label", app.applicationInfo.loadLabel(app.packageManager).toString()))
        // SP-0207: the settings LIST, never the direct exemption request (no REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).
        BatterySettings.actions(unrestricted()).forEach { action ->
            add(if (action == Settings.ACTION_APPLICATION_DETAILS_SETTINGS) details() else Intent(action))
        }
    })

    /** Opens the brand's Autostart list (the person switches Sunpride Field on there). */
    override fun openAutostart(activity: Context): Boolean = open(activity, buildList {
        autostartComponents[brand]?.forEach { (pkg, cls) -> add(Intent().setComponent(ComponentName(pkg, cls))) }
        add(details())
    })

    private fun details() = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${app.packageName}"))

    private fun open(activity: Context, intents: List<Intent>): Boolean = intents.any { intent ->
        if (activity !is android.app.Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { activity.startActivity(intent); true }
        catch (_: ActivityNotFoundException) { false }
        catch (_: SecurityException) { false }
    }

    companion object {
        private const val SHOWN = "shown"
        private val autostartComponents: Map<String, List<Pair<String, String>>> = run {
            val miui = listOf("com.miui.securitycenter" to "com.miui.permcenter.autostart.AutoStartManagementActivity")
            val color = listOf("com.coloros.safecenter" to "com.coloros.safecenter.permission.startup.StartupAppListActivity",
                "com.coloros.safecenter" to "com.coloros.safecenter.startupapp.StartupAppListActivity",
                "com.oplus.safecenter" to "com.oplus.safecenter.startupapp.StartupAppListActivity")
            val vivo = listOf("com.vivo.permissionmanager" to "com.vivo.permissionmanager.activity.BgStartUpManagerActivity",
                "com.iqoo.secure" to "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")
            val huawei = listOf("com.huawei.systemmanager" to "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity")
            val transsion = listOf("com.transsion.phonemaster" to "com.itel.autobootmanager.activity.AutoBootMgrActivity")
            mapOf("xiaomi" to miui, "redmi" to miui, "poco" to miui, "oppo" to color, "realme" to color, "oneplus" to color,
                "vivo" to vivo, "iqoo" to vivo, "huawei" to huawei, "honor" to huawei,
                "infinix" to transsion, "tecno" to transsion, "itel" to transsion)
        }
    }
}
