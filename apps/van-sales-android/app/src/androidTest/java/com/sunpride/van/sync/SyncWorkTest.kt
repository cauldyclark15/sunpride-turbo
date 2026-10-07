package com.sunpride.van.sync

import androidx.work.BackoffPolicy
import androidx.work.NetworkType
import org.junit.Assert.*
import org.junit.Test

class SyncWorkTest {
    @Test fun connectedUniqueWorkUsesExponentialBackoffAndSeparateStubInput() {
        val spec=SyncWork.request().workSpec
        assertEquals(NetworkType.CONNECTED,spec.constraints.requiredNetworkType)
        assertEquals(BackoffPolicy.EXPONENTIAL,spec.backoffPolicy); assertEquals(30000L,spec.backoffDelayDuration)
        assertTrue(SyncWork.request(true).workSpec.input.getBoolean("stub",false))
        assertFalse(spec.input.getBoolean("stub",false))
    }
}
