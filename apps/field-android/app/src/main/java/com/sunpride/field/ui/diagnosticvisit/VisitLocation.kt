package com.sunpride.field.ui.diagnosticvisit

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.location.LocationListener
import android.os.Build
import android.os.Looper
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import kotlin.coroutines.resume

interface VisitLocation {
    val requiresPermission: Boolean get() = true
    suspend fun fix(): JSONObject?
}

class AndroidVisitLocation(private val context: Context) : VisitLocation {
    override suspend fun fix(): JSONObject? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = when {
            manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
            manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
            else -> return null
        }
        val location = withTimeoutOrNull(15_000) {
            suspendCancellableCoroutine<Location?> { continuation ->
                val cancellation = CancellationSignal()
                if (Build.VERSION.SDK_INT >= 30) {
                    continuation.invokeOnCancellation { cancellation.cancel() }
                    manager.getCurrentLocation(provider, cancellation, ContextCompat.getMainExecutor(context)) { result ->
                        if (continuation.isActive) continuation.resume(result)
                    }
                } else {
                    val listener = object : LocationListener {
                        override fun onLocationChanged(result: Location) {
                            manager.removeUpdates(this)
                            if (continuation.isActive) continuation.resume(result)
                        }
                    }
                    continuation.invokeOnCancellation { manager.removeUpdates(listener) }
                    manager.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
                }
            }
        } ?: return null
        if (!location.hasAccuracy() || location.time <= 0) return null
        return JSONObject().put("latitude", location.latitude).put("longitude", location.longitude)
            .put("accuracyMeters", location.accuracy.toDouble())
            .put("fixTime", location.time)
            .put("provider", when (location.provider) { "gps" -> "gps"; "network" -> "network"; else -> "unknown" })
            .put("mockSignal", if (Build.VERSION.SDK_INT >= 31) location.isMock else location.isFromMockProvider)
    }
}
