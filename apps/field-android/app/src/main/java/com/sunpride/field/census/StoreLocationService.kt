package com.sunpride.field.census

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.sunpride.field.location.LocationShare
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import org.json.JSONObject

/** Started while the app is visible; keeps direct satellite GPS working when the screen closes. */
class StoreLocationService : Service() {
    companion object {
        fun start(context: Context) {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
                runCatching { ContextCompat.startForegroundService(context, Intent(context, StoreLocationService::class.java)) }
        }
    }
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val fixes = Channel<JSONObject>(Channel.CONFLATED)
    private val handler = Handler(Looper.getMainLooper())
    private val manager by lazy { getSystemService(Context.LOCATION_SERVICE) as LocationManager }
    private val backend by lazy { LocationShare.backend(this) }
    private var listening = false
    private val listener = LocationListener { l -> wire(l)?.let { fixes.trySend(it) } }
    private var running: Job? = null
    override fun onBind(intent: Intent?): IBinder? = null
    private fun wire(l: Location): JSONObject? {
        if (!l.hasAccuracy()) return null
        return JSONObject().put("latitude", l.latitude).put("longitude", l.longitude).put("accuracyMeters", l.accuracy.toDouble())
            .put("fixTime", l.time).put("provider", "gps").put("mockSignal", com.sunpride.integrity.DeviceIntegrity.mock(l, com.sunpride.field.BuildConfig.E2E_MOCK_LOCATION))
            .put("speedMetersPerSecond", if (l.hasSpeed()) l.speed.toDouble() else 0.0)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel("store_gps", "Store location", NotificationManager.IMPORTANCE_LOW))
            val notification = NotificationCompat.Builder(this, "store_gps").setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setContentTitle("Tagging store location").setContentText(StoreLocationTag.TIP)
                .setStyle(NotificationCompat.BigTextStyle().bigText(StoreLocationTag.TIP)).setOngoing(true).setSilent(true).build()
            ServiceCompat.startForeground(this, 4251, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            if (!listening) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) { stopSelf(); return START_NOT_STICKY }
                manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 5_000L, 0f, listener, Looper.getMainLooper())
                listening = true
            }
            running?.cancel()
            running = scope.launch {
                val epoch = backend.authorizationEpoch
                val account = backend.locationAccount()
                while (isActive && backend.isSignedIn && epoch == backend.authorizationEpoch && account == backend.locationAccount()) {
                    val fix = withTimeoutOrNull(5_000) { fixes.receive() }
                    val active = runCatching { backend.improveStoreLocations(fix, epoch, account) }.getOrDefault(false)
                    if (!active) break
                }
                handler.post { stopSelfResult(startId) }
            }
        } catch (_: Exception) { stopSelf() }
        return START_NOT_STICKY // a foreground launch resumes any unexpired encrypted sessions
    }
    override fun onDestroy() {
        if (listening) manager.removeUpdates(listener)
        scope.cancel(); fixes.close()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
