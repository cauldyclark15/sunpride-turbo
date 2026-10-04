package com.sunpride.field.ui.route

import com.sunpride.field.ui.VisitDisplay
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** AND-018: native map launch prefers the phone's maps app and falls back to web directions. */
class MapLaunchTest {
    private fun visit(lat: Double? = null, lng: Double? = null, address: String? = null) =
        VisitDisplay("Aling Nena & Sons", "Planned", "Scheduled", "o1", "p1", latitude = lat, longitude = lng,
            address = address)

    @Test fun verifiedPinOpensMapsAppThenWebDirectionsToTheSameCoordinates() {
        val geo = DailyRoutes.navigationUri(visit(14.5764, 121.0851, "12 Rizal Ave"))!!
        assertEquals(listOf(geo, "https://www.google.com/maps/dir/?api=1&destination=14.576400%2C121.085100"),
            MapLaunch.candidates(geo))
    }

    @Test fun addressOnlyOutletFallsBackToAnEncodedAddressSearch() {
        val geo = DailyRoutes.navigationUri(visit(address = "12 Rizal Ave, Pasig & Co?"))!!
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=12%20Rizal%20Ave%2C%20Pasig%20%26%20Co%3F",
            MapLaunch.webDirections(geo))
    }

    @Test fun southernAndWesternCoordinatesKeepTheirSign() {
        val geo = DailyRoutes.navigationUri(visit(-33.8688, -151.2093))!!
        assertEquals("https://www.google.com/maps/dir/?api=1&destination=-33.868800%2C-151.209300",
            MapLaunch.webDirections(geo))
    }

    @Test fun foreignUriIsNeverRewritten() {
        assertNull(MapLaunch.webDirections("geo:abc"))
        assertEquals(listOf("geo:abc"), MapLaunch.candidates("geo:abc"))
    }

    @Test fun stopsAtTheFirstProviderThatAcceptsAndReportsWhenNoneDoes() {
        val geo = DailyRoutes.navigationUri(visit(14.5, 121.0))!!
        val tried = mutableListOf<String>()
        assertTrue(MapLaunch.open(geo) { tried += it; true })
        assertEquals(listOf(geo), tried)

        tried.clear()
        assertTrue(MapLaunch.open(geo) { tried += it; it.startsWith("https:") })
        assertEquals(2, tried.size)

        tried.clear()
        assertFalse(MapLaunch.open(geo) { tried += it; false })
        assertEquals(2, tried.size)
    }
}
