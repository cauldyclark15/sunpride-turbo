package com.sunpride.field.sync.work

import android.content.Context
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.work.BackoffPolicy
import androidx.work.Configuration
import androidx.work.NetworkType
import androidx.work.WorkManager
import androidx.work.WorkInfo
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SyncWorkTest {
    private val context: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @After fun clean() { VisitSyncWorker.testSync = null }

    @Test fun requestIsConnectedExponentialAndUniqueAppendPolicy() {
        val request = SyncWork.request()
        assertEquals(NetworkType.CONNECTED, request.workSpec.constraints.requiredNetworkType)
        assertEquals(BackoffPolicy.EXPONENTIAL, request.workSpec.backoffPolicy)
        assertEquals(ExistingWorkPolicyExpected.APPEND, SyncWork.policy.name)
    }

    @Test fun uniqueEnqueueRetainsConnectedWorkInTestScheduler() {
        WorkManagerTestInitHelper.initializeTestWorkManager(context,
            Configuration.Builder().setMinimumLoggingLevel(Log.ERROR).build())
        SyncWork.enqueue(context)
        val infos = WorkManager.getInstance(context).getWorkInfosForUniqueWork(SyncWork.NAME)
            .get(10, TimeUnit.SECONDS)
        assertTrue(infos.isNotEmpty())
        assertTrue(infos.any { it.state == WorkInfo.State.ENQUEUED || it.state == WorkInfo.State.RUNNING })
        WorkManager.getInstance(context).cancelUniqueWork(SyncWork.NAME).result.get(10, TimeUnit.SECONDS)
    }

    // Isolated worker uses a test delegate; no real account, network or credentials.
    @Test fun workerReturnsSuccessRetryAndPropagatesStop() = runBlocking {
        val worker = TestListenableWorkerBuilder<VisitSyncWorker>(context).build()
        VisitSyncWorker.testSync = { com.sunpride.field.ui.syncstatus.SyncStatus(health = "synced") }
        assertTrue(worker.doWork() is androidx.work.ListenableWorker.Result.Success)
        VisitSyncWorker.testSync = { com.sunpride.field.ui.syncstatus.SyncStatus(queued = 1, health = "retry_pending") }
        assertTrue(worker.doWork() is androidx.work.ListenableWorker.Result.Retry)
        VisitSyncWorker.testSync = { com.sunpride.field.ui.syncstatus.SyncStatus(held = 1, health = "held_for_review") }
        assertTrue(worker.doWork() is androidx.work.ListenableWorker.Result.Success)
        VisitSyncWorker.testSync = { throw CancellationException("stopped") }
        try { worker.doWork(); fail("must stop") } catch (_: CancellationException) { Unit }
    }

    private object ExistingWorkPolicyExpected { const val APPEND = "APPEND_OR_REPLACE" }
}
