package com.sunpride.van.ui

import com.sunpride.van.data.SyncStatus

/** An old connection error cannot outlive a newer durable successful background sync. */
internal data class SyncFailureNotice(val text: String, val failedAt: Long) {
    fun resolved(status: SyncStatus): Boolean = status.health == "synced" &&
        status.lastSyncTime?.let { it >= failedAt } == true
}
