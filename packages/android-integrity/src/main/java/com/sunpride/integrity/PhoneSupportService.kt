package com.sunpride.integrity

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Non-secret completion signals. The UI observes effects; it does not own the polling job. */
object PhoneSupportEvents {
    private val finished = MutableStateFlow(0L)
    val runs = finished.asStateFlow()
    internal fun checked() { finished.update { it + 1 } }
}

/** SP-0249: ongoing office-control delivery, independent of Activity destruction and local outbox size.
 * specialUse describes remote support, not location tracking or a six-hour dataSync service.
 * Android may still suspend/stop us. No alarms, wake locks, battery exemptions or boot receiver.
 */
abstract class PhoneSupportService : Service() {
    protected abstract fun needed(): Boolean
    protected abstract suspend fun checkPhone()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val wake = Channel<Unit>(Channel.CONFLATED)
    private var polling: Job? = null
    private var lastStartId = 0
    private var destroyed = false
    private var networkRegistered = false
    private val networks by lazy { getSystemService(ConnectivityManager::class.java) }
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { wake.trySend(Unit) }
    }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate()
        runCatching { networks.registerDefaultNetworkCallback(callback); networkRegistered = true }
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        lastStartId = startId
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Office phone controls", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Checks for office phone requests while you are signed in"
                setShowBadge(false)
            })
            val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
                PendingIntent.getActivity(this, 249, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
            }
            val notification = NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
                .setContentTitle("Phone controls running")
                .setContentText("Checking for office requests. Saved work stays on this phone.")
                .setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
                .setCategory(NotificationCompat.CATEGORY_SERVICE)
                .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
                .apply { if (open != null) setContentIntent(open) }.build()
            // Promote before any disk/network work, including a sticky restart with no current sign-in.
            ServiceCompat.startForeground(this, NOTIFICATION_ID, notification,
                if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0)
        } catch (_: Exception) { stopSelf(startId); return START_NOT_STICKY }
        if (polling?.isActive != true) startPolling(startId)
        return START_STICKY
    }
    private fun startPolling(startId: Int) {
        polling = scope.launch {
            try {
                PhoneSupportLoop.run({ runCatching { needed() }.getOrDefault(false) }, {
                    networks.getNetworkCapabilities(networks.activeNetwork)
                        ?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
                }, ::checkPhone, PhoneSupportEvents::checked, wait = { ms ->
                    withTimeoutOrNull(ms) { wake.receive() }
                })
            } finally {
                withContext(NonCancellable + Dispatchers.Main.immediate) {
                    polling = null
                    if (!destroyed) {
                        // A new visible sign-in may have started us while the old run was exiting.
                        if (stopSelfResult(startId)) stopForeground(STOP_FOREGROUND_REMOVE)
                        else startPolling(lastStartId)
                    }
                }
            }
        }
    }
    override fun onTimeout(startId: Int, fgsType: Int) { stopSelf() }
    override fun onDestroy() {
        destroyed = true
        scope.cancel()
        if (networkRegistered) runCatching { networks.unregisterNetworkCallback(callback) }
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    companion object {
        const val CHANNEL = "office_phone_controls"
        const val NOTIFICATION_ID = 4249
        /** Called after a visible launch/sign-in, never as a background-start restriction workaround. */
        fun start(context: Context, service: Class<out PhoneSupportService>): Boolean = try {
            ContextCompat.startForegroundService(context.applicationContext, Intent(context, service))
            true
        } catch (_: IllegalStateException) { false }
        catch (_: SecurityException) { false }
    }
}
