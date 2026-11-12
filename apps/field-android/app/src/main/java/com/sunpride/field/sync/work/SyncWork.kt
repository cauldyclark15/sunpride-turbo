package com.sunpride.field.sync.work

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

/** Best-effort OS scheduling: no fixed latency, exact alarms, foreground service or location use. */
object SyncWork {
    const val NAME = "field-visit-sync"
    val policy = ExistingWorkPolicy.APPEND_OR_REPLACE
    fun request(): OneTimeWorkRequest = OneTimeWorkRequestBuilder<VisitSyncWorker>()
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .build()

    private val finished = kotlinx.coroutines.flow.MutableStateFlow(0L)
    /** FLD-122: bumps after every background run so the UI re-reads the pill and open forms (cf. EvidenceWork.runs). */
    val runs: kotlinx.coroutines.flow.StateFlow<Long> get() = finished
    internal fun finishedRun() { finished.value = finished.value + 1 }

    /**
     * FLD-122: run when there is work to send. A hold on THIS partition (e.g. a routine re-download after the office
     * changed today's plan) is retried once through the same verified path as "Sync now" (fresh sign-in check +
     * bootstrap proof), instead of waiting for a manual tap. Work from an earlier sign-in/work area stays held.
     */
    fun shouldRun(s: com.sunpride.field.ui.syncstatus.SyncStatus): Boolean = s.pending &&
        com.sunpride.field.ui.syncstatus.SyncStatus.HELD_EARLIER !in s.heldReasons &&
        (s.queued + s.sending > 0 || s.held > 0)

    fun enqueue(context: Context) {
        // APPEND_OR_REPLACE ensures a wake-up after an already-running flight finishes;
        // KEEP could discard the only wake-up for a row committed during that flight.
        // SP-0140: but never more than one queued run behind it (CoalescedWork).
        CoalescedWork.enqueue(context, NAME, ::request)
    }
}

class VisitSyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    companion object {
        /** Instrumentation-only seam. Always null in production; no credentials enter tests. */
        @Volatile internal var testSync: (suspend () -> com.sunpride.field.ui.syncstatus.SyncStatus)? = null
    }
    override suspend fun doWork(): Result {
        val app = applicationContext
        return try {
            testSync?.let { return outcome(it(), app) }
            val backend = LiveFieldBackend(AppEnvironment(BuildConfig.SUNPRIDE_API_ORIGIN),
                SessionVaults.app(app), app) { KeystoreDeviceKey.loadOrCreate(app) }
            if (!backend.isSignedIn) return Result.success()
            val device = backend.cachedDeviceId ?: return Result.success()
            val before = backend.syncStatus()
            if (!SyncWork.shouldRun(before)) return Result.success()
            SafeLog.event(app, "sync_started")
            val data = backend.today(device, backend.loadSigner(), sync = true, scheduleRemainder = false)
            outcome(data.syncStatus, app)
        } catch (e: kotlinx.coroutines.CancellationException) {
            SafeLog.event(app, "worker_stopped")
            throw e
        } catch (_: Exception) {
            SafeLog.event(app, "sync_retry"); Result.retry()
        } finally { SyncWork.finishedRun() }
    }
    private fun outcome(status: com.sunpride.field.ui.syncstatus.SyncStatus, app: Context): Result = when {
        status.held > 0 || status.health == "held_for_review" -> {
            SafeLog.event(app, "sync_held"); Result.success()
        }
        status.queued + status.sending > 0 -> { SafeLog.event(app, "sync_retry"); Result.retry() }
        else -> { SafeLog.event(app, "sync_complete"); Result.success() }
    }
}
