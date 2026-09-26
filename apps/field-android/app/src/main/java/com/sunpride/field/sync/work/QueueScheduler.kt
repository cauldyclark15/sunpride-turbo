package com.sunpride.field.sync.work

import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.IntentRow

/** The callback cannot run when Room rolls back enqueue; never schedule inside its transaction. */
object QueueScheduler {
    suspend fun enqueue(store: FieldStore, intent: IntentRow, now: Long, afterCommit: () -> Unit) {
        store.enqueue(intent, now)
        // A scheduler failure cannot uncommit an already durable intent. App-start recovery re-enqueues it.
        runCatching { afterCommit() }
    }
}
