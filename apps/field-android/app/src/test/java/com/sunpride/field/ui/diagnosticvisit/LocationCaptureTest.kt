package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.StoreScope
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class LocationCaptureTest {
    private val now = 1_790_000_000_000L
    private fun fix(accuracy: Double = 8.0, age: Long = 1_000, provider: String = "fused", mock: Boolean = false) =
        LocationFix(14.6, 121.0, accuracy, now - age, provider, mock)

    @Test fun policyMirrorsTheServerLocationPolicy() {
        val source = listOf("../../../packages/backend/convex/visits/policy.ts", "../../packages/backend/convex/visits/policy.ts")
            .map(::File).first { it.exists() }.readText()
        assertTrue(source.contains("version: \"${LocationPolicy.VERSION}\""))
        assertTrue(source.contains("maxAccuracyMeters: ${LocationPolicy.MAX_ACCURACY_METERS.toInt()},"))
        assertTrue(source.contains("maxFixAgeMs: 60_000,"))
        assertEquals(60_000L, LocationPolicy.MAX_FIX_AGE_MS)
    }

    @Test fun wireCarriesCoordinatesAccuracyTimeProviderAndMockIndicator() {
        val wire = LocationCapture.Captured(fix(mock = true)).wire!!
        assertEquals(setOf("latitude", "longitude", "accuracyMeters", "fixTime", "provider", "mockSignal"), wire.keys().asSequence().toSet())
        assertEquals("fused", wire.getString("provider"))
        assertTrue(wire.getBoolean("mockSignal"))
        assertEquals(now - 1_000, wire.getLong("fixTime"))
        assertNull(LocationCapture.Unavailable(UnavailableReason.PERMISSION_DENIED).wire)
        // Never a client geofence verdict on the wire.
        assertFalse(wire.has("withinGeofence"))
    }

    @Test fun fusedFixFlowsIntoTheCheckInPayload() {
        val row = VisitIntentFactory.create(StoreScope("a", "d", "s"), "visit.checkIn", null, null, null, "planned",
            "outlet", emptyList(), null, null, null, null, LocationCapture.Captured(fix()).wire, at = now)
        val location = JSONObject(row.serializedOperation).getJSONObject("payload").getJSONObject("location")
        assertEquals("fused", location.getString("provider"))
        assertEquals(8.0, location.getDouble("accuracyMeters"), 0.0)
    }

    @Test fun parsesProvidersAndRejectsMalformedFixes() {
        assertEquals("unknown", LocationFix.fromJson(fix().toJson().put("provider", "passive"))!!.provider)
        assertNull(LocationFix.fromJson(fix().toJson().put("latitude", 91)))
        assertNull(LocationFix.fromJson(JSONObject().put("latitude", 1)))
        assertNull(LocationFix.fromJson(null))
    }

    @Test fun selectorPrefersFreshThenRealThenTighterFixes() {
        val stale = fix(accuracy = 3.0, age = 120_000)
        val weak = fix(accuracy = 80.0)
        assertSame(weak, FixSelector.better(stale, weak, now))
        val mock = fix(accuracy = 2.0, mock = true)
        assertSame(weak, FixSelector.better(weak, mock, now))
        val tight = fix(accuracy = 6.0)
        assertSame(tight, FixSelector.better(weak, tight, now))
        assertSame(tight, FixSelector.better(null, tight, now))
        assertTrue(FixSelector.reliable(tight, now))
        assertFalse(FixSelector.reliable(weak, now))
        assertFalse(FixSelector.reliable(stale, now))
        assertFalse(FixSelector.reliable(mock, now))
        assertFalse(FixSelector.reliable(fix(provider = "unknown"), now))
        assertFalse(FixSelector.reliable(fix(age = -5_000), now))
    }

    @Test fun noticesFlagReviewWithoutBlocking() {
        assertEquals(LocationNotice("Location recorded · ±8 m", false),
            LocationAssessment.notice(LocationCapture.Captured(fix()), now))
        val flagged = LocationAssessment.notice(LocationCapture.Captured(fix(accuracy = 120.0, age = 90_000, mock = true)), now)
        assertTrue(flagged.review)
        assertEquals("Location recorded · ±120 m · supervisor will review: mock location detected, weak signal, old fix", flagged.text)
        assertEquals(LocationNotice("Location unavailable · supervisor will review: location permission off", true),
            LocationAssessment.notice(LocationCapture.Unavailable(UnavailableReason.PERMISSION_DENIED), now))
        assertTrue(LocationAssessment.notice(LocationCapture.Unavailable(UnavailableReason.LOCATION_OFF), now).text
            .endsWith("phone location turned off"))
    }

    @Test fun fakesThatOnlyReturnJsonStillCapture() = runBlocking {
        val fake = object : VisitLocation { override suspend fun fix(): JSONObject? = fix(provider = "gps").toJson() }
        assertEquals("gps", (fake.captureOrUnavailable() as LocationCapture.Captured).fix.provider)
        val broken = object : VisitLocation { override suspend fun fix(): JSONObject? = throw SecurityException() }
        assertEquals(LocationCapture.Unavailable(UnavailableReason.NO_FIX), broken.captureOrUnavailable())
        Unit
    }
}
