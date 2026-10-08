package com.sunpride.van.location

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.diagnostics.SafeLog
import com.sunpride.van.storage.StoreScope

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

/** The one-time consent, per person and phone registration, versioned with [LocationConsentText.VERSION]. */
class LocationConsentStore(context: Context, stub: Boolean) {
    private val prefs = context.applicationContext.getSharedPreferences(if (stub) "van_stub_location_consent" else "van_location_consent",Context.MODE_PRIVATE)
    private fun key(scope: StoreScope) = hex(sha256("${scope.fullAuthSubject}|${scope.deviceId}".toByteArray(Charsets.UTF_8)))
    fun consented(scope: StoreScope): Boolean = prefs.getInt(key(scope),0) >= LocationConsentText.VERSION
    fun set(scope: StoreScope, accepted: Boolean) {
        val editor = prefs.edit()
        if (accepted) editor.putInt(key(scope),LocationConsentText.VERSION) else editor.remove(key(scope))
        check(editor.commit())
    }
}

class AndroidLocationSharing(context: Context, private val stub: Boolean) : LocationSharing {
    private val app = context.applicationContext
    private val consent = LocationConsentStore(app,stub)
    private var last: Pair<StoreScope?,Boolean>? = null
    override val enabled = true
    override fun consented(scope: StoreScope) = consent.consented(scope)
    override fun setConsent(scope: StoreScope, accepted: Boolean) = consent.set(scope,accepted)
    private fun granted(permission: String) = ContextCompat.checkSelfPermission(app,permission) == PackageManager.PERMISSION_GRANTED
    override fun permitted(): Boolean {
        val location = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        val on = runCatching { (app.getSystemService(Context.LOCATION_SERVICE) as LocationManager).isLocationEnabled }.getOrDefault(false)
        return location && on
    }
    override fun missingPermissions(): List<String> = buildList {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) { add(Manifest.permission.ACCESS_FINE_LOCATION); add(Manifest.permission.ACCESS_COARSE_LOCATION) }
        if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS)) add(Manifest.permission.POST_NOTIFICATIONS)
    }
    override fun update(scope: StoreScope?, track: Boolean) {
        val state = (if (track) scope else null) to track
        if (state == last) return
        last = state
        try {
            if (track && scope != null) ContextCompat.startForegroundService(app,TripLocationService.start(app,scope,stub))
            else app.startService(TripLocationService.stop(app,scope,stub))
        } catch (_: Exception) {
            // Background start refused (Android 12+) or the service could not start: try again on the next change.
            last = null
            SafeLog.event(app,"location_service_refused")
        }
    }
}

/** Opens Android's settings for this app (permission denied for good) or the location switch (location off). */
fun locationSettingsIntent(context: Context, permissionMissing: Boolean): Intent =
    if (permissionMissing) Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, android.net.Uri.fromParts("package",context.packageName,null))
    else Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS)
