package com.sunpride.field.location

/**
 * SP-0140: cheap Android phones (Xiaomi/Redmi/POCO first, also OPPO/realme/vivo/Infinix/Tecno...)
 * kill background apps to save battery, which silently stops work-day location sharing even with
 * the foreground-service notification. A one-time guide asks the person to set the app's battery
 * use to "No restrictions" and, on phones that have it, to allow Autostart.
 *
 * Pure rules here (JVM-tested); [AndroidBatteryGuide] reads the phone and opens the settings pages.
 */
object BatteryGuideRules {
    /** Brands whose battery manager is known to stop foreground location apps (dontkillmyapp.com). */
    private val aggressive = setOf("xiaomi", "redmi", "poco", "oppo", "realme", "oneplus", "vivo", "iqoo",
        "huawei", "honor", "samsung", "infinix", "tecno", "itel", "meizu", "asus", "nokia", "lenovo", "motorola")
    /** Brands with a separate Autostart switch (off by default for side-loaded apps). */
    private val autostart = setOf("xiaomi", "redmi", "poco", "oppo", "realme", "oneplus", "vivo", "iqoo",
        "huawei", "honor", "infinix", "tecno", "itel", "meizu", "asus")

    fun brand(manufacturer: String?, brand: String? = null): String =
        listOfNotNull(manufacturer, brand).map { it.trim().lowercase() }
            .firstOrNull { it in aggressive } ?: manufacturer?.trim()?.lowercase().orEmpty()

    fun aggressive(brand: String): Boolean = brand in aggressive
    fun hasAutostart(brand: String): Boolean = brand in autostart

    /**
     * Show the guide once per phone, automatically after location sharing is set up, when the battery
     * setting still restricts the app or the brand has an Autostart switch (it cannot be read back).
     */
    fun shouldShow(shown: Boolean, unrestricted: Boolean, brand: String): Boolean =
        !shown && (!unrestricted || hasAutostart(brand))

    /** The Today card offers the guide again while the battery setting can still stop sharing. */
    fun offerAgain(sharing: Boolean, unrestricted: Boolean): Boolean = sharing && !unrestricted

    fun batteryStep(brand: String): String = when (brand) {
        "xiaomi", "redmi", "poco" -> "Battery saver → No restrictions"
        "samsung" -> "Battery → Unrestricted"
        "huawei", "honor" -> "App launch → Manage manually, all switches on"
        else -> "Battery → No restrictions (or Don't optimise)"
    }

    fun autostartStep(brand: String): String = when (brand) {
        "xiaomi", "redmi", "poco" -> "Autostart → on for Sunpride Field"
        "oppo", "realme", "oneplus" -> "Auto launch → on for Sunpride Field"
        "vivo", "iqoo" -> "Background / Autostart → on for Sunpride Field"
        else -> "Autostart → on for Sunpride Field"
    }
}

/** What the guide screen shows. */
data class BatteryGuideView(val brand: String, val unrestricted: Boolean, val autostart: Boolean) {
    val batteryStep: String get() = BatteryGuideRules.batteryStep(brand)
    val autostartStep: String get() = BatteryGuideRules.autostartStep(brand)
}

/** The phone side of the guide (Android in the app, a fake in tests). Read methods run off the main thread. */
interface BatteryGuideHost {
    fun view(): BatteryGuideView
    fun shouldShow(): Boolean
    fun markShown()
    fun openBattery(activity: android.content.Context): Boolean
    fun openAutostart(activity: android.content.Context): Boolean
}
