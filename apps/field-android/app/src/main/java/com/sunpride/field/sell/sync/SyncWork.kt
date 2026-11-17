package com.sunpride.field.sell.sync

import android.content.Context
import androidx.work.*
import com.sunpride.field.sell.data.VanRepository
import java.util.concurrent.TimeUnit

/**
 * The Sell area's background sender (the Van app's, on the Field session). Enqueued only after something was saved in the
 * Sell area, so a person without Selling never has this work scheduled.
 */
object SyncWork {
    const val NAME = "field-sell-sync"
    fun request(stub: Boolean = false): OneTimeWorkRequest = OneTimeWorkRequestBuilder<VanSyncWorker>()
        .setInputData(workDataOf("stub" to stub))
        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL,30,TimeUnit.SECONDS).build()
    fun enqueue(context: Context, stub: Boolean = false) {
        WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(if (stub) "$NAME-stub" else NAME,ExistingWorkPolicy.APPEND_OR_REPLACE,request(stub))
    }
}
class VanSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context,params) {
    override suspend fun doWork(): Result {
        val backend = com.sunpride.field.ui.LiveFieldBackend.forWorker(applicationContext)
        // Selling switched off (or signed out) since this was queued: nothing is sent; the saved work stays on this phone.
        if (!backend.isSignedIn || !backend.sellingEnabled()) return Result.success()
        val repository = VanRepository.forWorker(applicationContext,backend.sellAccess(),inputData.getBoolean("stub",false))
        return try {
            repository.restoreSession()
            when {
                !repository.sessionState.value.signedIn -> Result.success()
                repository.enrollmentState.value !is com.sunpride.field.sell.auth.EnrollmentState.Ready -> Result.success()
                // VAN-083: a close waiting for the office's cash receipt is sent again with backoff, without a tap.
                else -> { repository.syncNow(); if (repository.closeWaitsForOffice()) Result.retry() else Result.success() }
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: VanSyncFailure) { if (e.retryable) Result.retry() else Result.failure() }
        catch (e: com.sunpride.field.sell.auth.AuthFailure) { if (e.kind == com.sunpride.field.sell.auth.AuthFailure.Kind.OFFLINE || e.kind == com.sunpride.field.sell.auth.AuthFailure.Kind.SERVER) Result.retry() else Result.failure() }
        catch (_: Exception) { Result.retry() }
        finally { repository.close() }
    }
}
