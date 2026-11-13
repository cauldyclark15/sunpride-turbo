package com.sunpride.callflow

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/** F-106: one permission-aware capture adapter; no Play Services requirement on cheap phones. */
object AndroidCallLocation {
    /**
     * `benchTestProvider` is the app's BuildConfig.E2E_MOCK_LOCATION: true ONLY in an opted-in dev build, so the
     * e2e bench can put a phone at a store with adb's test location provider. Prod, staging and beta pass false and
     * a mock fix is still reported (and refused by [CallFlowEngine.location]).
     */
    suspend fun capture(context: Context, benchTestProvider: Boolean = false): JSONObject? {
        val precise = ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!precise && !coarse) return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        if (!manager.isLocationEnabled) return null
        val providers = buildList {
            if (Build.VERSION.SDK_INT >= 31 && manager.hasProvider(LocationManager.FUSED_PROVIDER) && manager.isProviderEnabled(LocationManager.FUSED_PROVIDER)) add(LocationManager.FUSED_PROVIDER)
            else { if (precise && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
                if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) add(LocationManager.NETWORK_PROVIDER) }
        }
        val updates = Channel<Location>(Channel.UNLIMITED)
        val listener = LocationListener { updates.trySend(it) }
        var best: Location? = null
        try {
            providers.forEach { provider -> manager.getLastKnownLocation(provider)?.let { updates.trySend(it) }; manager.requestLocationUpdates(provider,1000,0f,listener,Looper.getMainLooper()) }
            withTimeoutOrNull(20_000) {
                for (candidate in updates) {
                    if (!candidate.hasAccuracy() || candidate.time <= 0) continue
                    if (best == null || candidate.accuracy < best!!.accuracy || candidate.time > best!!.time+60_000) best = candidate
                    if (candidate.accuracy <= 50 && kotlin.math.abs(System.currentTimeMillis()-candidate.time) <= 60_000) break
                }
            }
        } catch (_: SecurityException) { return null }
        finally { manager.removeUpdates(listener); updates.close() }
        return best?.let { fix -> fixJson(fix.latitude,fix.longitude,fix.accuracy.toDouble(),fix.time,fix.provider,
            if (Build.VERSION.SDK_INT >= 31) fix.isMock else @Suppress("DEPRECATION") fix.isFromMockProvider, benchTestProvider) }
    }
    /** The wire fix. A platform-reported mock stays a mock unless this is the opted-in dev bench build. */
    fun fixJson(latitude: Double, longitude: Double, accuracyMeters: Double, fixTime: Long, provider: String?,
        reportedMock: Boolean, benchTestProvider: Boolean): JSONObject =
        JSONObject().put("latitude",latitude).put("longitude",longitude).put("accuracyMeters",accuracyMeters)
            .put("fixTime",fixTime).put("provider",if (provider in setOf("gps","network","fused")) provider else "unknown")
            .put("mockSignal",reportedMock && !benchTestProvider)
}
