package com.sunpride.field.sell.location

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.sunpride.field.device.hex
import com.sunpride.field.device.sha256
import com.sunpride.field.sell.diagnostics.SafeLog
import com.sunpride.field.sell.storage.StoreScope

/**
 * SP-0137: what the UI needs to run live-location sharing. [Disabled] (the default) shows nothing and never
 * tracks, so screens and tests that do not care keep working; the app passes [AndroidLocationSharing].
 */
interface LocationSharing {
    val enabled: Boolean
    fun consented(scope: StoreScope): Boolean
    fun setConsent(scope: StoreScope, accepted: Boolean)
    /** Location permission granted and location turned on. */
    fun permitted(): Boolean
    /** Android permissions still to ask for (location, and notifications on Android 13+). */
    fun missingPermissions(): List<String>
    /** Starts the foreground service for [scope] when [track], otherwise asks it to record `stop` and end. */
    fun update(scope: StoreScope?, track: Boolean)

    object Disabled : LocationSharing {
        override val enabled = false
        override fun consented(scope: StoreScope) = false
        override fun setConsent(scope: StoreScope, accepted: Boolean) {}
        override fun permitted() = false
        override fun missingPermissions() = emptyList<String>()
        override fun update(scope: StoreScope?, track: Boolean) {}
    }
}


/** Opens Android's settings for this app (permission denied for good) or the location switch (location off). */
fun locationSettingsIntent(context: Context, permissionMissing: Boolean): Intent =
    if (permissionMissing) Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package",context.packageName,null))
    else Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
