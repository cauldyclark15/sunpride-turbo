package com.sunpride.field.ui

/**
 * SP-0207 (Google Play policy): app updates come from Google Play only. The app never downloads or installs an
 * APK; "Check for updates" opens this app's Play listing (Play app first, then the web page).
 */
object PlayStoreUpdate {
    /** The Google Play Store app: asked for by name so phones with a second store (Xiaomi GetApps) don't offer it. */
    const val PLAY_PACKAGE = "com.android.vending"
    fun uris(packageName: String): List<String> = listOf(
        "market://details?id=$packageName",
        "https://play.google.com/store/apps/details?id=$packageName")
}
