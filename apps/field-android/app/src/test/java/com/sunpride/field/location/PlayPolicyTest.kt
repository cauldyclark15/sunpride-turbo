package com.sunpride.field.location

import com.sunpride.field.ui.PlayStoreUpdate
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** SP-0207: what Google Play review checks in the Field app. */
class PlayPolicyTest {
    @Test fun disclosureAlwaysComesBeforeAndroidsLocationPrompt() {
        assertEquals(LocationStep.DISCLOSURE, LocationDisclosureGate.onStart(consented = false, locationAllowed = false))
        // Even with permission already granted (e.g. from an older build), the person still sees the disclosure first.
        assertEquals(LocationStep.DISCLOSURE, LocationDisclosureGate.onStart(consented = false, locationAllowed = true))
        assertEquals(LocationStep.SYSTEM_PROMPT, LocationDisclosureGate.onStart(consented = true, locationAllowed = false))
        assertEquals(LocationStep.START, LocationDisclosureGate.onStart(consented = true, locationAllowed = true))
    }

    @Test fun batteryGuideOpensSettingsScreensNeverTheExemptionRequest() {
        for (unrestricted in listOf(true, false)) {
            val actions = BatterySettings.actions(unrestricted)
            assertFalse(actions.contains(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS))
            assertEquals(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, actions.last())
        }
        assertEquals(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS, BatterySettings.actions(false).first())
    }

    @Test fun updatesPointToGooglePlayOnly() {
        assertEquals(listOf("market://details?id=com.sunpride.field.beta",
            "https://play.google.com/store/apps/details?id=com.sunpride.field.beta"), PlayStoreUpdate.uris("com.sunpride.field.beta"))
        assertEquals("com.android.vending", PlayStoreUpdate.PLAY_PACKAGE)
    }

    @Test fun manifestAsksForNoRestrictedPermissionAndNoInstallPath() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        for (removed in listOf("REQUEST_INSTALL_PACKAGES", "REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "ACCESS_BACKGROUND_LOCATION"))
            assertFalse(removed, Regex("uses-permission[^>]*$removed").containsMatchIn(manifest))
        assertFalse(manifest.contains(".updates\""))
        assertTrue(manifest.contains("android:foregroundServiceType=\"location\""))
        val sources = File("src/main").walk().filter { it.extension == "kt" }.map { it.readText() }.joinToString("\n")
        for (gone in listOf("application/vnd.android.package-archive", "ACTION_MANAGE_UNKNOWN_APP_SOURCES",
            "Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS", "Manifest.permission.ACCESS_BACKGROUND_LOCATION", "AppUpdatePanel("))
            assertFalse(gone, sources.contains(gone))
    }
}
