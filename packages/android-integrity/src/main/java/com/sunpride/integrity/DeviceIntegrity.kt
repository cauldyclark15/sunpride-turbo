package com.sunpride.integrity

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import org.json.JSONObject
import java.io.File

/**
 * F-312: an evidence photo is stamped with a REAL capture fix, so without one it is not taken. The message is for the
 * person holding the phone (FLD-147: the refusal must be shown, never only logged).
 */
class EvidenceLocationUnavailable(message: String) : IllegalStateException(message) {
    companion object {
        const val PERMISSION = "Allow location to take visit photos. Each photo is stamped with where it was taken."
        const val MOCK = "Turn off mock location before recording a visit or photo"
        const val NO_FIX = "No fresh location yet, so the photo can't be stamped. Turn Location on, step outside " +
            "or near a window for a moment, then tap Take photo again."
    }
}

/** F-024: local heuristics, NEVER represented as verified hardware/MDM attestation. */
object DeviceIntegrity {
    fun report(): JSONObject {
        val root=listOf("/system/bin/su","/system/xbin/su","/sbin/su","/data/adb/magisk").any { File(it).exists() }
        val tampered=Build.TAGS?.contains("test-keys")==true
        return JSONObject().put("rooted",root).put("tampered",tampered).put("source","android-self-report").put("verified",false)
    }
    /** GPS/fused observation used at CAPTURE, not the outlet's master pin. Never invent coordinates. */
    fun captureLocation(context: Context, now: Long=System.currentTimeMillis(), benchTestProvider: Boolean=false): Location {
        if (!(context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED))
            throw EvidenceLocationUnavailable(EvidenceLocationUnavailable.PERMISSION)
        val manager=context.getSystemService(LocationManager::class.java)
        val providers=manager.getProviders(true)
        val fixes=providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
        // A reported mock on any fresh source must not be hidden by a clean cached source.
        if (fixes.any { now-it.time in 0..60_000 && mock(it, benchTestProvider) }) throw EvidenceLocationUnavailable(EvidenceLocationUnavailable.MOCK)
        return fixes.filter { it.hasAccuracy() && now-it.time in 0..60_000 && !mock(it, benchTestProvider) }.minByOrNull { it.accuracy }
            ?: throw EvidenceLocationUnavailable(EvidenceLocationUnavailable.NO_FIX)
    }
    /** `benchTestProvider` is the app's BuildConfig.E2E_MOCK_LOCATION: true ONLY in the dev flavor, so e2e runs can put
     * the bench phone at a store with adb's test location provider. Prod, staging and beta always pass false. */
    @Suppress("DEPRECATION")
    fun mock(location: Location, benchTestProvider: Boolean=false): Boolean =
        reportedMock(if(Build.VERSION.SDK_INT>=31) location.isMock else location.isFromMockProvider, benchTestProvider)
    fun reportedMock(raw: Boolean, benchTestProvider: Boolean): Boolean = raw && !benchTestProvider
}
