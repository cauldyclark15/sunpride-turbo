package com.sunpride.field.evidence

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkerParameters
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.auth.SessionVaults
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
        com.sunpride.field.sync.work.CoalescedWork.enqueue(context, NAME, ::request) // SP-0140: one queued run
    }
    private val finished = kotlinx.coroutines.flow.MutableStateFlow(0L)
    /**
     * FLD-147: bumps each time a background upload run changes photo state. The open app re-reads its
     * local status then, so the pill and the visit's Photos card move on from "photos uploading" at once.
     */
    val runs: kotlinx.coroutines.flow.StateFlow<Long> get() = finished
    fun notifyFinished(report: UploadReport) {
        if (report.uploaded > 0 || report.review > 0) finished.value = finished.value + 1
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
                val backend = LiveFieldBackend(AppEnvironment(BuildConfig.SUNPRIDE_API_ORIGIN),
                    SessionVaults.app(app), app) { KeystoreDeviceKey.loadOrCreate(app) }
                if (!backend.isSignedIn) return Result.success()
                backend.uploadEvidence()
            }
            if (report.uploaded > 0) com.sunpride.field.sync.work.SyncWork.enqueue(app) // release a configured End waiting on required evidence
            EvidenceWork.notifyFinished(report)
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
