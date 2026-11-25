package com.sunpride.field.census

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.MainActivity
import com.sunpride.field.auth.SessionVaults
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.LiveFieldBackend
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.TimeUnit

/** Local reminders contain a count only, never customer details or session material.
 * WorkManager is best effort under battery saver; no network or exact-alarm permission. */
object CustomerDraftReminders {
    private const val CHANNEL = "customer-drafts"
    private const val ID = 241
    private const val WORK = "customer-draft-morning"
    const val OPEN = "open-customer-drafts"

    fun morningDelay(now: Long): Long {
        val local = Instant.ofEpochMilli(now).atZone(ZoneId.of("Asia/Manila"))
        var next = local.toLocalDate().atTime(8, 0).atZone(local.zone)
        if (!next.isAfter(local)) next = next.plusDays(1)
        return next.toInstant().toEpochMilli() - now
    }

    fun update(context: Context, count: Int, announce: Boolean = false) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (count <= 0) {
            manager.cancel(ID)
            WorkManager.getInstance(context).cancelUniqueWork(WORK)
            return
        }
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Customers to complete", NotificationManager.IMPORTANCE_DEFAULT))
        if (announce || manager.activeNotifications.any { it.id == ID }) {
          if (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            val open = PendingIntent.getActivity(context, ID,
                Intent(context, MainActivity::class.java).putExtra(OPEN, true).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            manager.notify(ID, NotificationCompat.Builder(context, CHANNEL)
                .setSmallIcon(android.R.drawable.ic_menu_edit).setContentTitle("$count drafts to complete")
                .setContentText("Open Customers to finish the missing details.").setContentIntent(open)
                .setAutoCancel(true).setOnlyAlertOnce(!announce).setVisibility(NotificationCompat.VISIBILITY_PRIVATE).build())
          }
        }
        WorkManager.getInstance(context).enqueueUniqueWork(WORK, ExistingWorkPolicy.KEEP,
            OneTimeWorkRequestBuilder<CustomerDraftReminderWorker>()
                .setInitialDelay(morningDelay(System.currentTimeMillis()), TimeUnit.MILLISECONDS).build())
    }
}

class CustomerDraftReminderWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = try {
        val app = applicationContext
        val backend = LiveFieldBackend(AppEnvironment(BuildConfig.SUNPRIDE_API_ORIGIN), SessionVaults.app(app), app) {
            KeystoreDeviceKey.loadOrCreate(app)
        }
        val epoch = backend.authorizationEpoch
        val count = if (backend.isSignedIn) CustomerDrafts.parse(backend.customerDraft()).saved.size else 0
        if (backend.authorizationEpoch == epoch) {
            CustomerDraftReminders.update(app, count, announce = true)
            // KEEP during the current run cannot enqueue tomorrow: append after this bounded run.
            if (count > 0) WorkManager.getInstance(app).enqueueUniqueWork("customer-draft-morning", ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<CustomerDraftReminderWorker>()
                    .setInitialDelay(CustomerDraftReminders.morningDelay(System.currentTimeMillis()), TimeUnit.MILLISECONDS).build())
        }
        Result.success()
    } catch (e: kotlinx.coroutines.CancellationException) { throw e }
    catch (_: Exception) { Result.retry() }
}
