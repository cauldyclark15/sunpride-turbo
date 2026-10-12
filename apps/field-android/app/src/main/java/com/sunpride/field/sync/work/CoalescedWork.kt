package com.sunpride.field.sync.work

import android.content.Context
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequest
import androidx.work.WorkInfo
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * SP-0140: one queued upload is enough. Visit sync, photo upload and location upload each ask for a
 * run after every new row; while the phone is offline those asks used to pile up as a chain of
 * dozens of queued runs (APPEND_OR_REPLACE), each waking the phone when the network came back.
 *
 * A run that has not started yet reads every row committed before it starts, so a new ask is
 * dropped when one is already waiting (ENQUEUED, including a retry in back-off, or BLOCKED behind
 * the running one). When the only run is RUNNING it may have read the buffer already, so the ask is
 * still appended: no committed row is ever left without a run after it. Call off the main thread.
 */
object CoalescedWork {
    /** Pure decision (JVM-tested): append only when nothing is already waiting to start. */
    fun shouldEnqueue(states: List<WorkInfo.State>): Boolean =
        states.none { it == WorkInfo.State.ENQUEUED || it == WorkInfo.State.BLOCKED }

    fun enqueue(context: Context, name: String, request: () -> OneTimeWorkRequest) {
        val manager = WorkManager.getInstance(context.applicationContext)
        // Unknown state (timeout, WorkManager error): enqueue as before rather than risk skipping.
        val states = runCatching { manager.getWorkInfosForUniqueWork(name).get(2, TimeUnit.SECONDS).map { it.state } }
            .getOrNull()
        if (states != null && !shouldEnqueue(states)) return
        manager.enqueueUniqueWork(name, ExistingWorkPolicy.APPEND_OR_REPLACE, request())
    }
}
