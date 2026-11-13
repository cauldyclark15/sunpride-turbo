package com.sunpride.van.sync

import android.content.Context
import androidx.work.*
import com.sunpride.van.data.VanRepository
import java.util.concurrent.TimeUnit

object SyncWork {
    const val NAME = "van-sales-sync"
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
        val repository = VanRepository.forWorker(applicationContext,inputData.getBoolean("stub",false))
        return try {
            repository.restoreSession()
            when {
                !repository.sessionState.value.signedIn -> Result.success()
                repository.sessionState.value.offlinePending -> Result.retry()
                repository.enrollmentState.value !is com.sunpride.van.auth.EnrollmentState.Ready -> Result.success()
                // VAN-083: a close waiting for the office's cash receipt is sent again with backoff, without a tap.
                else -> { repository.syncNow(); if (repository.closeWaitsForOffice()) Result.retry() else Result.success() }
            }
        } catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (e: VanSyncFailure) { if (e.retryable) Result.retry() else Result.failure() }
        catch (e: com.sunpride.van.auth.AuthFailure) { if (e.kind == com.sunpride.van.auth.AuthFailure.Kind.OFFLINE || e.kind == com.sunpride.van.auth.AuthFailure.Kind.SERVER) Result.retry() else Result.failure() }
        catch (_: Exception) { Result.retry() }
        finally { repository.close() }
    }
}
