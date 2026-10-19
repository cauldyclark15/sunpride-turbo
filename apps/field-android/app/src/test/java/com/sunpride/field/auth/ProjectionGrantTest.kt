package com.sunpride.field.auth

import org.junit.Assert.*
import org.junit.Test
import org.junit.Before

class ProjectionGrantTest {
    private val prefs = mutableMapOf<String, String>()
    private var rejectWrites = false
    @Before fun reset() { ProjectionGrant.retire() }
    private fun grant(filter: String) = ProjectionGrant("account-phone-scope", "team", prefs::get,
        { k, v -> if (rejectWrites) false else { prefs[k] = v; true } }).also { it.begin(filter) }
    @Test fun matchingDurableGrantReadsAfterRepositoryReopen() {
        val a = grant("direct"); val text = a.wrap("saved summary")!!
        assertEquals("saved summary", grant("direct").read(text))
    }
    @Test fun denialWithdrawsEveryFilterAndOneRenewalDoesNotUnlockAnother() {
        val direct = grant("direct").wrap("direct")!!
        val all = grant("all").wrap("all")!!
        grant("direct").deny()
        assertNull(grant("all").read(all)); assertNull(grant("direct").read(direct))
        val renewed = grant("direct").wrap("new direct")!!
        assertEquals("new direct", grant("direct").read(renewed)); assertNull(grant("all").read(all))
        ProjectionGrant.retire()
        assertNull(grant("all").read(all))
    }
    @Test fun failedDenialMarkerStillLatchesBeforeFallibleStorage() {
        val retained = grant("all").wrap("retained")!!
        rejectWrites = true; grant("direct").deny()
        assertNull(grant("all").read(retained)); assertNull(grant("direct").wrap("cannot renew insecurely"))
    }
    @Test fun delayedSuccessCannotUndoNewerRefusalInABASequence() {
        val firstA = grant("A"); grant("B"); val latestA = grant("A"); latestA.deny()
        assertNull(firstA.wrap("late old success")); assertFalse(firstA.current())
    }
    @Test fun signOutEpochRetiresOldResponseEvenAfterSameScopeReturns() {
        val old = grant("A"); ProjectionGrant.retire(); grant("A")
        assertNull(old.wrap("retired session")); assertFalse(old.current())
    }
}
