package com.sunpride.van.ui

import com.sunpride.van.data.SyncStatus
import org.junit.Assert.*
import org.junit.Test

class SyncFailureNoticeTest {
    private val problem=SyncFailureNotice("Offline",1000)
    @Test fun oldSuccessMustNotHideNewFailure() {
        assertFalse(problem.resolved(SyncStatus(health="synced",lastSyncTime=999)))
    }
    @Test fun newDurableBackgroundSuccessResolvesItEvenWithPriorReviewWork() {
        assertTrue(problem.resolved(SyncStatus(health="synced",lastSyncTime=1001,review=1)))
    }
    @Test fun retryPendingAndMissingSuccessDoNotResolveIt() {
        assertFalse(problem.resolved(SyncStatus(health="retry_pending",lastSyncTime=1001)))
        assertFalse(problem.resolved(SyncStatus(health="synced")))
    }
}
