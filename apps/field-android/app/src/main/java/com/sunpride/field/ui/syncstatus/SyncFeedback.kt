package com.sunpride.field.ui.syncstatus

import com.sunpride.field.ui.TodayData

/** SP-0198: feedback for a Sync now attempt, separate from the three simple saved-work labels. */
object SyncFeedback {
    const val RUNNING = "Syncing your phone…"
    const val UPDATED = "Sync finished. Your phone is up to date."
    const val WAITING = "Your work is saved on this phone. Some items are still waiting to send."
    const val UNAVAILABLE = "Could not sync now. Your saved work is kept. Try again."
    const val UPDATE = "Update the app, then try Sync now again."

    /** The last Sync now result, unless the phone state since makes it untrue (offline or work waiting). */
    fun shown(message: String?, status: SyncStatus): String? =
        if (message == UPDATED && (status.offline || !status.nothingWaiting)) null else message

    /** Fixed copy only: never show a raw transport exception or a server-supplied warning. */
    fun result(data: TodayData, sellFailed: Boolean = false): String = when {
        data.updateRequired -> UPDATE
        data.warning != null || data.lastSynced == null || data.syncStatus.health != "synced" -> UNAVAILABLE
        sellFailed || data.syncStatus.waiting > 0 || data.stale -> WAITING
        else -> UPDATED
    }
}
