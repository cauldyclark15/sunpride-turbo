package com.sunpride.field.location

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.auth.SessionVaults
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.diagnostics.SafeLog
import com.sunpride.field.ui.LiveFieldBackend
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.util.concurrent.TimeUnit

/** SharedPreferences-backed work-day state (non-secret: a hashed account key, timestamps, consent time). */
class SharedWorkDayPrefs(context: Context) : WorkDayPrefs {
    private val prefs = context.applicationContext.getSharedPreferences("work_day", Context.MODE_PRIVATE)
    override fun get(key: String): String? = prefs.getString(key, null)
    override fun put(key: String, value: String?) { prefs.edit().apply { if (value == null) remove(key) else putString(key, value) }.commit() }
}

object LocationShare {
    fun permissions(context: Context): LocationPermissions {
        fun granted(p: String) = ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED
        val location = granted(Manifest.permission.ACCESS_FINE_LOCATION) || granted(Manifest.permission.ACCESS_COARSE_LOCATION)
        return LocationPermissions(location, location && granted(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
    }

    /** The phone's work day for whoever is signed in (resolved through the backend's verified partition). */
    fun workDay(context: Context, account: () -> String?): WorkDay {
        val app = context.applicationContext
        return WorkDay(SharedWorkDayPrefs(app), account, { permissions(app) }, AndroidLocationService(app, account))
    }

    fun backend(context: Context): LiveFieldBackend {
        val app = context.applicationContext
        return LiveFieldBackend(AppEnvironment(BuildConfig.CONVEX_SITE_URL, BuildConfig.CONVEX_URL),
            SessionVaults.app(app), app) { KeystoreDeviceKey.loadOrCreate(app) }
    }

    fun battery(context: Context): Int? = runCatching {
        (context.getSystemService(Context.BATTERY_SERVICE) as BatteryManager)
            .getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
    }.getOrNull()

    @Suppress("DEPRECATION")
    fun fix(location: Location): Fix = Fix(location.latitude, location.longitude,
        if (location.hasAccuracy()) location.accuracy.toDouble() else 1_000.0,
        if (location.hasSpeed()) location.speed.toDouble() else null,
        if (location.hasBearing()) location.bearing.toDouble() else null,
        if (Build.VERSION.SDK_INT >= 31) location.isMock else location.isFromMockProvider,
        location.time)

    /** The final "stop" ping at End day / sign-out / 10 PM, from the last known position. */
    fun recordStop(context: Context, backend: LiveFieldBackend, now: Long) {
        val last = LocationShareService.latest ?: return
        val startedAt = LocationShareService.startedAt
        val at = if (WorkHours.within(now)) now else WorkHours.closeAt(startedAt ?: now) - 1_000
        if (at < last.time || !WorkHours.within(at)) return
        runCatching { backend.recordLocation(last.copy(time = at), "stop", battery(context), now) }
        LocationShareService.latest = null
    }
}

/** Starts the foreground service from the UI (allowed while the app is in front); stops it anywhere. */
class AndroidLocationService(private val context: Context, private val account: () -> String?) : LocationService {
    override fun start() {
        runCatching {
            ContextCompat.startForegroundService(context, Intent(context, LocationShareService::class.java))
        }.onFailure { SafeLog.event(context, "location_start_refused") }
    }
    override fun stop() {
        if (LocationShareService.latest != null) runCatching {
            LocationShare.recordStop(context, LocationShare.backend(context), System.currentTimeMillis())
        }
        context.stopService(Intent(context, LocationShareService::class.java))
        runCatching { LocationUploadWork.enqueue(context) }
    }
}

/**
 * SP-0136: the work-day location service (foreground, type `location`) with the ongoing notification
 * "Sunpride is sharing your location for work". It runs only while [WorkDay.tracking] holds — it
 * re-checks on every fix and every minute, so End day, sign-out, a revoked permission or the 10 PM
 * daily close stop it even if nobody opens the app. Balanced-power priority, batched delivery, and
 * [PingCadence] decide what is recorded; pings go to the encrypted store and upload in batches.
 */
class LocationShareService : Service() {
    companion object {
        const val CHANNEL = "location_sharing"
        const val NOTIFICATION_ID = 4136
        const val TEXT = "Sunpride is sharing your location for work"
        const val TICK_MS = 60_000L
        const val UPLOAD_EVERY = 10
        const val UPLOAD_INTERVAL_MS = 5 * 60_000L
        /** Last position seen this process (for the final stop ping). Never persisted. */
        @Volatile var latest: Fix? = null
        @Volatile var startedAt: Long? = null

        fun ensureChannel(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(CHANNEL) == null) manager.createNotificationChannel(
                NotificationChannel(CHANNEL, "Location sharing", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while Sunpride shares your location during the work day"
                    setShowBadge(false)
                })
        }

        fun notification(context: Context): Notification {
            ensureChannel(context)
            val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
                PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            return NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Location sharing on")
                .setContentText(TEXT)
                .setStyle(NotificationCompat.BigTextStyle().bigText("$TEXT. It stops when you tap End day, sign out, or at 10 PM."))
                .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .apply { if (open != null) setContentIntent(open) }
                .build()
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var backend: LiveFieldBackend
    private lateinit var workDay: WorkDay
    private var requesting = false
    private var last: Fix? = null
    private var sinceUpload = 0
    private var lastUploadAt = 0L
    private val tick = object : Runnable {
        override fun run() {
            if (!checkStillTracking()) return
            handler.postDelayed(this, TICK_MS)
        }
    }
    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            if (!checkStillTracking()) return
            result.locations.sortedBy { it.time }.forEach { onFix(LocationShare.fix(it)) }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        backend = LocationShare.backend(this)
        workDay = LocationShare.workDay(this) { backend.locationAccount() }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // startForegroundService() requires startForeground() within seconds, even when we then stop.
        val started = try {
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(this),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            true
        } catch (_: Exception) {
            // No location permission, or a background restart Android refuses: the day stays started
            // and the Today card shows "Location off" until the app is opened again.
            SafeLog.event(this, "location_start_refused"); false
        }
        if (!started) { stopSelf(); return START_NOT_STICKY }
        if (!checkStillTracking()) return START_NOT_STICKY
        if (!requesting) requestUpdates()
        handler.removeCallbacks(tick); handler.postDelayed(tick, TICK_MS)
        return START_STICKY
    }

    @SuppressLint("MissingPermission") // checked by WorkDay.tracking just before
    private fun requestUpdates() {
        val request = LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, PingCadence.MOVING_INTERVAL_MS)
            .setMinUpdateIntervalMillis(PingCadence.MIN_SPACING_MS * 2)
            .setMaxUpdateDelayMillis(3 * PingCadence.MOVING_INTERVAL_MS) // batched delivery saves battery
            .build()
        try {
            LocationServices.getFusedLocationProviderClient(this).requestLocationUpdates(request, callback, Looper.getMainLooper())
            requesting = true
            startedAt = workDay.state().startedAt
            SafeLog.event(this, "location_started")
        } catch (_: SecurityException) { stopNow() }
    }

    /** False (and the service stops) once End day, sign-out, 10 PM or a revoked permission ended the day. */
    private fun checkStillTracking(): Boolean {
        val now = System.currentTimeMillis()
        if (workDay.tracking(now)) return true
        workDay.closeIfDue(now)
        scope.launch { LocationShare.recordStop(this@LocationShareService, backend, now); enqueueUpload() }
        stopNow()
        return false
    }

    private fun onFix(fix: Fix) {
        latest = fix
        val trigger = PingCadence.decide(last, fix) ?: return
        last = fix
        val now = System.currentTimeMillis()
        val battery = LocationShare.battery(this)
        scope.launch {
            val stored = runCatching { backend.recordLocation(fix, trigger, battery, now) }.getOrDefault(false)
            if (!stored) return@launch
            sinceUpload++
            if (trigger == "start" || sinceUpload >= UPLOAD_EVERY || now - lastUploadAt >= UPLOAD_INTERVAL_MS) enqueueUpload()
        }
    }

    private fun enqueueUpload() {
        sinceUpload = 0; lastUploadAt = System.currentTimeMillis()
        runCatching { LocationUploadWork.enqueue(this) }
    }

    private fun stopNow() {
        handler.removeCallbacks(tick)
        if (requesting) runCatching { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(callback) }
        requesting = false
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        if (requesting) runCatching { LocationServices.getFusedLocationProviderClient(this).removeLocationUpdates(callback) }
        requesting = false
        SafeLog.event(this, "location_stopped")
        super.onDestroy()
    }
}

/** Uploads buffered pings when the phone is online (unique, network-constrained, exponential backoff). */
object LocationUploadWork {
    const val NAME = "field-location-upload"
    fun enqueue(context: Context) {
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(NAME, ExistingWorkPolicy.APPEND_OR_REPLACE,
            OneTimeWorkRequestBuilder<LocationUploadWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build())
    }
}

class LocationUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result {
        val app = applicationContext
        return try {
            val backend = LocationShare.backend(app)
            if (!backend.isSignedIn) return Result.success()
            val report = backend.uploadLocation()
            SafeLog.event(app, if (report.retryLater) "location_retry" else "location_uploaded")
            if (report.retryLater) Result.retry() else Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            SafeLog.event(app, "location_retry"); Result.retry()
        }
    }
}
