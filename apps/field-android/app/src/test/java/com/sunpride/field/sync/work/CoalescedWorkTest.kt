package com.sunpride.field.sync.work

import androidx.work.WorkInfo.State
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** SP-0140: offline asks collapse into one queued run, but a running flight always gets a follow-up. */
class CoalescedWorkTest {
    @Test fun enqueuesWhenNothingIsQueued() {
        assertTrue(CoalescedWork.shouldEnqueue(emptyList()))
        assertTrue(CoalescedWork.shouldEnqueue(listOf(State.SUCCEEDED, State.CANCELLED, State.FAILED)))
    }

    @Test fun appendsBehindARunningFlightThatMayHaveReadTheBufferAlready() {
        assertTrue(CoalescedWork.shouldEnqueue(listOf(State.RUNNING)))
        assertTrue(CoalescedWork.shouldEnqueue(listOf(State.SUCCEEDED, State.RUNNING)))
    }

    @Test fun dropsTheAskWhenARunIsAlreadyWaitingToStart() {
        assertFalse("offline: the queued run will read every row", CoalescedWork.shouldEnqueue(listOf(State.ENQUEUED)))
        assertFalse("already one follow-up behind the running flight",
            CoalescedWork.shouldEnqueue(listOf(State.RUNNING, State.BLOCKED)))
    }
}
