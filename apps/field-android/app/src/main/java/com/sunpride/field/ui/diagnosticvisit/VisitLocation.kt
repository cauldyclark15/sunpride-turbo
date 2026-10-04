package com.sunpride.field.ui.diagnosticvisit

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Looper
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

interface VisitLocation {
    val requiresPermission: Boolean get() = true
    suspend fun fix(): JSONObject?
    /** Fix plus the reason it is missing; fakes that only implement [fix] report NO_FIX. */
    suspend fun capture(): LocationCapture = LocationFix.fromJson(fix())
        ?.let { LocationCapture.Captured(it) } ?: LocationCapture.Unavailable(UnavailableReason.NO_FIX)
}

/** A failure is evidence (null), not permission to prevent arrival/end recording. No distance gate. */
suspend fun VisitLocation.captureOrNull(): JSONObject? = captureOrUnavailable().wire

suspend fun VisitLocation.captureOrUnavailable(): LocationCapture = try { capture() }
    catch (e: CancellationException) { throw e }
    catch (_: Exception) { LocationCapture.Unavailable(UnavailableReason.NO_FIX) }

/**
 * Fused location: Android's platform fused provider (API 31+; works with approximate permission and needs
 * no Google Play services), else GPS plus network. Listens for up to [LocationPolicy.CAPTURE_BUDGET_MS] and
 * stops early on the first fix the server policy would accept; otherwise keeps the best one, so a weak fix
 * is still recorded and flagged for supervisor review rather than lost.
 */
class AndroidVisitLocation(private val context: Context) : VisitLocation {
    override suspend fun fix(): JSONObject? = captureOrUnavailable().wire

    override suspend fun capture(): LocationCapture {
        val precise = granted(Manifest.permission.ACCESS_FINE_LOCATION)
        val approximate = granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (!precise && !approximate) return LocationCapture.Unavailable(UnavailableReason.PERMISSION_DENIED)
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        if (!manager.isLocationEnabled) return LocationCapture.Unavailable(UnavailableReason.LOCATION_OFF)
        val providers = buildList {
            if (Build.VERSION.SDK_INT >= 31 && manager.hasProvider(LocationManager.FUSED_PROVIDER) &&
                manager.isProviderEnabled(LocationManager.FUSED_PROVIDER)) add(LocationManager.FUSED_PROVIDER)
            else {
                if (precise && manager.isProviderEnabled(LocationManager.GPS_PROVIDER)) add(LocationManager.GPS_PROVIDER)
                if (manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) add(LocationManager.NETWORK_PROVIDER)
            }
        }
        if (providers.isEmpty()) return LocationCapture.Unavailable(UnavailableReason.LOCATION_OFF)
        val updates = Channel<Location>(Channel.UNLIMITED)
        val listener = LocationListener { updates.trySend(it) }
        var best: LocationFix? = null
        try {
            try {
                providers.forEach { provider ->
                    // A recent cached fix answers indoors at once; the selector still prefers fresh updates.
                    manager.getLastKnownLocation(provider)?.let { updates.trySend(it) }
                    manager.requestLocationUpdates(provider, 1_000L, 0f, listener, Looper.getMainLooper())
                }
            } catch (_: SecurityException) {
                // Permission revoked between the check and the request.
                return LocationCapture.Unavailable(UnavailableReason.PERMISSION_DENIED)
            }
            withTimeoutOrNull(LocationPolicy.CAPTURE_BUDGET_MS) {
                for (location in updates) {
                    val candidate = location.toFix() ?: continue
                    val now = System.currentTimeMillis()
                    val chosen = FixSelector.better(best, candidate, now)
                    best = chosen
                    if (FixSelector.reliable(chosen, now)) break
                }
            }
        } finally {
            manager.removeUpdates(listener)
            updates.close()
        }
        return best?.let { LocationCapture.Captured(it) } ?: LocationCapture.Unavailable(UnavailableReason.NO_FIX)
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun Location.toFix(): LocationFix? = try {
        if (!hasAccuracy() || time <= 0) null
        else LocationFix(latitude, longitude, accuracy.toDouble(), time, LocationFix.provider(provider),
            if (Build.VERSION.SDK_INT >= 31) isMock else @Suppress("DEPRECATION") isFromMockProvider)
    } catch (_: IllegalArgumentException) { null }
}
