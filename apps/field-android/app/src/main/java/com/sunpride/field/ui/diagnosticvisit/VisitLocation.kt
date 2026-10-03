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
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import kotlin.coroutines.resume

interface VisitLocation {
    val requiresPermission: Boolean get() = true
    suspend fun fix(): JSONObject?
}

/** A failure is evidence (null), not permission to prevent arrival/end recording. No distance gate. */
suspend fun VisitLocation.captureOrNull(): JSONObject? = try { fix() }
    catch (e: CancellationException) { throw e }
    catch (_: Exception) { null }

class AndroidVisitLocation(private val context: Context) : VisitLocation {
    override suspend fun fix(): JSONObject? = try { currentFix() }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) { null }

    private suspend fun currentFix(): JSONObject? {
        val precise = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        val approximate = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (!precise && !approximate) return null
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val provider = when {
            precise && manager.isProviderEnabled(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
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
