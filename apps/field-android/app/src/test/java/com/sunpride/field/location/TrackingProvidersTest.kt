package com.sunpride.field.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class TrackingProvidersTest {
    @Test fun modernPhoneUsesTheSamePlatformFusedProviderAsVisitCapture() {
        assertEquals(listOf("fused"), TrackingProviders.choose(36, setOf("fused", "network", "gps"), true))
    }
    @Test fun approximatePermissionStillUsesPlatformFused() {
        assertEquals(listOf("fused"), TrackingProviders.choose(31, setOf("fused", "gps"), false))
    }
    @Test fun legacyPrecisePhoneFallsBackToNetworkAndGps() {
        assertEquals(listOf("network", "gps"), TrackingProviders.choose(29, setOf("fused", "network", "gps"), true))
    }
    @Test fun approximateFallbackNeverRequestsGps() {
        assertEquals(listOf("network"), TrackingProviders.choose(30, setOf("network", "gps"), false))
    }
    @Test fun missingOrDisabledProvidersNeverPretendTheSubscriptionStarted() {
        assertTrue(TrackingProviders.choose(36, emptySet(), true).isEmpty())
        assertTrue(TrackingProviders.choose(30, setOf("gps"), false).isEmpty())
    }
}
