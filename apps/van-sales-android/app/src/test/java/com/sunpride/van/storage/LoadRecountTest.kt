package com.sunpride.van.storage

import org.junit.Assert.*
import org.junit.Test

/** IP-P0: after the office sends a counted load back, the seller can count again; double counts stay refused. */
class LoadRecountTest {
    private fun fact(id: String, status: String, at: Long) = ConfirmFact(id, status, at)

    @Test fun firstCountIsAllowedWhenNothingWasSent() {
        assertTrue(LoadRecount.mayConfirm(emptyList(), null))
        assertFalse(LoadRecount.waitingForOffice(emptyList(), null))
    }
    @Test fun aCountStillOnThePhoneBlocksASecondOne() {
        assertFalse(LoadRecount.mayConfirm(listOf(fact("a", "pending", 1)), null))
        assertFalse(LoadRecount.mayConfirm(listOf(fact("a", "sending", 1)), null))
    }
    @Test fun anAcknowledgedCountBlocksUntilTheBundleShowsIt() {
        // Server accepted "a" but the bundle on the phone is older and does not name it yet.
        assertFalse(LoadRecount.mayConfirm(listOf(fact("a", "done", 1)), null))
        assertTrue(LoadRecount.waitingForOffice(listOf(fact("a", "done", 1)), null))
    }
    @Test fun confirmThenAckThenRejectedBundleAllowsAFreshCount() {
        // The review's case: confirm, ack done, bundle says planned and names the count the office sent back.
        assertTrue(LoadRecount.mayConfirm(listOf(fact("a", "done", 1)), "a"))
        assertFalse(LoadRecount.waitingForOffice(listOf(fact("a", "done", 1)), "a"))
    }
    @Test fun aSecondRoundIsHeldUntilItsOwnRejectionComesBack() {
        val rows = listOf(fact("a", "done", 1), fact("b", "pending", 5))
        assertFalse(LoadRecount.mayConfirm(rows, "a"))
        val acked = listOf(fact("a", "done", 1), fact("b", "done", 5))
        assertFalse("bundle still shows the first rejection",LoadRecount.mayConfirm(acked, "a"))
        assertTrue("office sent the second count back too",LoadRecount.mayConfirm(acked, "b"))
    }
    @Test fun aRefusedCountDoesNotBlockACorrectedOne() {
        assertTrue(LoadRecount.mayConfirm(listOf(fact("a", "rejected", 1)), null))
    }
}
