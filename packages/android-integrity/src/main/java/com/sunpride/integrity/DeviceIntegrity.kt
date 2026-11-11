package com.sunpride.integrity

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.os.Build
import org.json.JSONObject
import java.io.File

/** F-024: local heuristics, NEVER represented as verified hardware/MDM attestation. */
object DeviceIntegrity {
    fun report(): JSONObject {
        val root=listOf("/system/bin/su","/system/xbin/su","/sbin/su","/data/adb/magisk").any { File(it).exists() }
        val tampered=Build.TAGS?.contains("test-keys")==true
        return JSONObject().put("rooted",root).put("tampered",tampered).put("source","android-self-report").put("verified",false)
    }
    /** GPS/fused observation used at CAPTURE, not the outlet's master pin. Never invent coordinates. */
    fun captureLocation(context: Context, now: Long=System.currentTimeMillis(), benchTestProvider: Boolean=false): Location {
        check(context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)==PackageManager.PERMISSION_GRANTED ||
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED) { "Allow location before taking evidence photos" }
        val manager=context.getSystemService(LocationManager::class.java)
        val providers=manager.getProviders(true)
        val fixes=providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
        // A reported mock on any fresh source must not be hidden by a clean cached source.
        check(fixes.none { now-it.time in 0..60_000 && mock(it, benchTestProvider) }) { "Turn off mock location before recording a visit or photo" }
        return checkNotNull(fixes.filter { it.hasAccuracy() && now-it.time in 0..60_000 && !mock(it, benchTestProvider) }.minByOrNull { it.accuracy }) { "Get a fresh location fix before taking the photo" }
    }
    /** `benchTestProvider` is the app's BuildConfig.E2E_MOCK_LOCATION: true ONLY in the dev flavor, so e2e runs can put
     * the bench phone at a store with adb's test location provider. Prod, staging and beta always pass false. */
    @Suppress("DEPRECATION")
    fun mock(location: Location, benchTestProvider: Boolean=false): Boolean =
        reportedMock(if(Build.VERSION.SDK_INT>=31) location.isMock else location.isFromMockProvider, benchTestProvider)
    fun reportedMock(raw: Boolean, benchTestProvider: Boolean): Boolean = raw && !benchTestProvider
}
