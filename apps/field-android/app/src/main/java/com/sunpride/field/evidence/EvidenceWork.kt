package com.sunpride.field.evidence

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.auth.KeystoreSessionVault
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.diagnostics.SafeLog
import com.sunpride.field.ui.LiveFieldBackend
import java.util.concurrent.TimeUnit

/**
 * AND-016: photo uploads get their own unique, network-constrained work so a slow or large
 * upload never delays the visit outbox, and the OS retries with backoff after reconnecting.
 */
object EvidenceWork {
    const val NAME = "field-evidence-upload"
    val policy = ExistingWorkPolicy.APPEND_OR_REPLACE
    fun request(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<EvidenceUploadWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()
    fun enqueue(context: Context) {
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(NAME, policy, request())
    }
}

class EvidenceUploadWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    companion object {
        /** Instrumentation-only seam. Always null in production; no credentials enter tests. */
        @Volatile internal var testUpload: (suspend () -> UploadReport)? = null
    }
    override suspend fun doWork(): Result {
        val app = applicationContext
        return try {
            val report = testUpload?.invoke() ?: run {
                val backend = LiveFieldBackend(AppEnvironment(BuildConfig.CONVEX_SITE_URL, BuildConfig.CONVEX_URL),
                    KeystoreSessionVault(app), app) { KeystoreDeviceKey.loadOrCreate(app) }
                if (!backend.isSignedIn) return Result.success()
                backend.uploadEvidence()
            }
            SafeLog.event(app, if (report.retryLater) "photo_retry" else "photo_complete")
            if (report.retryLater) Result.retry() else Result.success()
        } catch (e: kotlinx.coroutines.CancellationException) {
            SafeLog.event(app, "worker_stopped")
            throw e
        } catch (_: Exception) {
            SafeLog.event(app, "photo_retry"); Result.retry()
        }
    }
}
