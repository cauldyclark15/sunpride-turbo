package com.sunpride.van.location

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import android.os.Looper
import com.sunpride.van.MainActivity
import com.sunpride.van.diagnostics.SafeLog
import com.sunpride.van.storage.EncryptedVanDatabase
import com.sunpride.van.storage.LocationPingStore
import com.sunpride.van.storage.StoreScope
import com.sunpride.van.storage.VanDatabase
import com.sunpride.van.sync.SyncWork
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * SP-0137: shares the truck's location while the trip is on the road. A foreground service (ongoing
 * notification) so it keeps running with the screen off. Every fix goes through [LocationPingStore.record],
 * which re-checks in its transaction that this scope's trip is still on the road; once it is not (trip closed
 * here, reassigned), the service records `stop` and ends itself. Uses the platform LocationManager (GPS and
 * network), so it needs no Google Play services on the handheld.
 */
class TripLocationService : Service(), LocationListener {
    private val work = CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val lock = Mutex()
    private var database: VanDatabase? = null
    private var store: LocationPingStore? = null
    private var stub = false
    private var listening = false
    private var latest: LocationFix? = null
    private var waiting = 0
    private var lastUploadAsk = 0L
    /** Bumped by every start/stop command, so a finishing stop never ends a newer start. */
    @Volatile private var generation = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val prefs = getSharedPreferences(PREFS,MODE_PRIVATE)
        // A sticky restart after the process was killed comes back without an intent: resume the saved scope.
        val action = intent?.action ?: if (prefs.contains("subject")) ACTION_START else ACTION_STOP
        val scope = intent?.scope() ?: prefs.scope()
        stub = intent?.getBooleanExtra(EXTRA_STUB,false) ?: prefs.getBoolean("stub",false)
        val run = ++generation
        if (action == ACTION_START && scope != null) {
            if (!foreground()) { stopSelf(); return START_NOT_STICKY }
            prefs.edit().putString("subject",scope.fullAuthSubject).putString("device",scope.deviceId).putBoolean("stub",stub).commit()
            open(scope)
            listen()
            SafeLog.event(this,"location_on")
            return START_STICKY
        }
        stopSharing(scope,run,startId)
        return START_NOT_STICKY
    }

    /** Records the `stop` ping for [scope] (saved or given), then ends unless a newer start arrived meanwhile. */
    private fun stopSharing(scope: StoreScope?, run: Int, startId: Int?) {
        getSharedPreferences(PREFS,MODE_PRIVATE).edit().clear().commit()
        silence()
        work.launch {
            try { scope?.let { open(it); lock.withLock { store?.recordStop(latest,battery()) }; upload(force = true) } }
            catch (_: Exception) { SafeLog.event(this@TripLocationService,"location_service_refused") }
            finally {
                SafeLog.event(this@TripLocationService,"location_off")
                if (generation == run) { stopForegroundCompat(); if (startId != null) stopSelf(startId) else stopSelf() }
            }
        }
    }

    private fun open(scope: StoreScope) {
        if (store?.scope == scope) return
        val db = database ?: (if (stub) EncryptedVanDatabase.openStub(this) else EncryptedVanDatabase.open(this)).also { database = it }
        store = LocationPingStore(db,scope)
    }

    private fun foreground(): Boolean = try {
        val notification = notification()
        startForeground(NOTIFICATION_ID,notification,ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        true
    } catch (_: Exception) { SafeLog.event(this,"location_service_refused"); false }

    @SuppressLint("MissingPermission") // AndroidLocationSharing starts this service only with location permission.
    private fun listen() {
        if (listening) return
        val manager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try {
            for (provider in listOf(LocationManager.GPS_PROVIDER,LocationManager.NETWORK_PROVIDER)) {
                if (provider in manager.allProviders) manager.requestLocationUpdates(provider,LocationPolicy.FIX_REQUEST_MS,0f,this,Looper.getMainLooper())
            }
            listening = true
        } catch (_: SecurityException) {
            // Permission withdrawn in Settings: nothing can be shared; the app shows "Location sharing off".
            stopForegroundCompat(); stopSelf()
        }
    }

    private fun silence() {
        if (!listening) return
        runCatching { (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(this) }
        listening = false
    }

    override fun onLocationChanged(location: Location) {
        val fix = toFix(location) ?: return
        // GPS and network both report; never step backwards in time.
        if ((latest?.recordedAt ?: 0L) >= fix.recordedAt) return
        // Prefer GPS: a coarser network fix arriving right after a good GPS fix is ignored.
        val previous = latest
        if (previous != null && fix.provider == "network" && previous.provider == "gps" && fix.recordedAt-previous.recordedAt < LocationPolicy.MOVING_INTERVAL_MS) return
        latest = fix
        work.launch {
            val outcome = try { lock.withLock { store?.record(fix,battery()) } } catch (_: Exception) { null }
            when (outcome) {
                is LocationPingStore.Outcome.Recorded -> { waiting++; upload(force = outcome.trigger == "start") }
                // The trip is no longer on the road (closed on this phone or by the office).
                LocationPingStore.Outcome.NotOnTrip -> android.os.Handler(Looper.getMainLooper()).post { stopSharing(store?.scope,++generation,null) }
                else -> {}
            }
        }
    }

    // Android 10 (minSdk 29) has no default bodies for these; the framework calls them.
    @Deprecated("Deprecated in Android") override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    /** Asks the sync worker to send waiting pings: at the start, after a few pings, or every 5 minutes. */
    private fun upload(force: Boolean) {
        val now = System.currentTimeMillis()
        if (!force && waiting < LocationPolicy.UPLOAD_AFTER_PINGS && now-lastUploadAsk < LocationPolicy.UPLOAD_AFTER_MS) return
        waiting = 0; lastUploadAsk = now
        runCatching { SyncWork.enqueue(this,stub) }
    }

    private fun battery(): Int? = runCatching {
        (getSystemService(Context.BATTERY_SERVICE) as BatteryManager).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
    }.getOrNull()

    private fun notification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL,"Location sharing",NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while the truck's location is shared during a trip"
        })
        val open = PendingIntent.getActivity(this,0,Intent(this,MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),PendingIntent.FLAG_IMMUTABLE)
        return Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Location sharing on")
            .setContentText("Your supervisors see the truck until you close the trip.")
            .setOngoing(true).setContentIntent(open).setCategory(Notification.CATEGORY_SERVICE)
            .apply { if (Build.VERSION.SDK_INT >= 31) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE) }
            .build()
    }

    private fun stopForegroundCompat() = stopForeground(STOP_FOREGROUND_REMOVE)

    override fun onDestroy() {
        silence()
        work.cancel()
        database?.close(); database = null; store = null
        super.onDestroy()
    }

    companion object {
        private const val ACTION_START = "com.sunpride.van.location.START"
        private const val ACTION_STOP = "com.sunpride.van.location.STOP"
        private const val EXTRA_SUBJECT = "subject"
        private const val EXTRA_DEVICE = "device"
        private const val EXTRA_STUB = "stub"
        private const val PREFS = "van_location_service"
        private const val CHANNEL = "trip_location"
        private const val NOTIFICATION_ID = 4137

        fun start(context: Context, scope: StoreScope, stub: Boolean): Intent = Intent(context,TripLocationService::class.java).setAction(ACTION_START)
            .putExtra(EXTRA_SUBJECT,scope.fullAuthSubject).putExtra(EXTRA_DEVICE,scope.deviceId).putExtra(EXTRA_STUB,stub)
        fun stop(context: Context, scope: StoreScope?, stub: Boolean): Intent = Intent(context,TripLocationService::class.java).setAction(ACTION_STOP)
            .putExtra(EXTRA_STUB,stub).apply { scope?.let { putExtra(EXTRA_SUBJECT,it.fullAuthSubject).putExtra(EXTRA_DEVICE,it.deviceId) } }

        private fun Intent.scope(): StoreScope? {
            val subject = getStringExtra(EXTRA_SUBJECT) ?: return null
            val device = getStringExtra(EXTRA_DEVICE) ?: return null
            return runCatching { StoreScope(subject,device) }.getOrNull()
        }
        private fun android.content.SharedPreferences.scope(): StoreScope? {
            val subject = getString("subject",null) ?: return null
            val device = getString("device",null) ?: return null
            return runCatching { StoreScope(subject,device) }.getOrNull()
        }

        /** Android fix → wire fix; null when it is unusable. */
        fun toFix(location: Location): LocationFix? = runCatching {
            val mock = if (Build.VERSION.SDK_INT >= 31) location.isMock else @Suppress("DEPRECATION") location.isFromMockProvider
            LocationFix(location.time,location.latitude,location.longitude,
                if (location.hasAccuracy()) location.accuracy.toDouble() else LocationPolicy.MAX_ACCURACY_M,
                if (location.hasSpeed()) location.speed.toDouble() else null,
                if (location.hasBearing()) location.bearing.toDouble() else null,
                LocationFix.provider(location.provider),mock)
        }.getOrNull()
    }
}
