package com.sunpride.field.ui.route

import com.sunpride.field.ui.VisitDisplay
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DailyRouteTest {
    private fun stop(name: String, sequence: Int?, status: String = "Scheduled", listPosition: Int? = null,
        lat: Double? = null, lng: Double? = null, address: String? = null) =
        VisitDisplay(name, "Planned", status, "outlet-$name", "plan-$name", sequence = sequence,
            listPosition = listPosition, latitude = lat, longitude = lng, address = address)

    @Test fun ordersByMcpSequenceThenDownloadOrderAndNumbersFromOne() {
        val route = DailyRoutes.build(listOf(stop("C", 3), stop("A", 1), stop("X", null, listPosition = 2),
            stop("B", 2)), null)
        // Equal positions keep their original list order (B before X, both at 2).
        assertEquals(listOf("A", "X", "B", "C"), route.stops.map { it.visit.outlet })
        assertEquals(listOf(1, 2, 3, 4), route.stops.map { it.number })
    }

    @Test fun firstUnfinishedStopIsNextAndLaterStopsWait() {
        val route = DailyRoutes.build(listOf(stop("A", 1, "Done"), stop("B", 2), stop("C", 3)), null)
        assertEquals(listOf(StopState.DONE, StopState.NEXT, StopState.LATER), route.stops.map { it.state })
        assertEquals("B", route.next?.visit?.outlet)
        assertEquals(1, route.done)
    }

    @Test fun anOpenCallIsTheOnlyCurrentStop() {
        val route = DailyRoutes.build(listOf(stop("A", 1, "In progress"), stop("B", 2)), null)
        assertEquals(listOf(StopState.IN_PROGRESS, StopState.LATER), route.stops.map { it.state })
        assertEquals("A", route.next?.visit?.outlet)
    }

    @Test fun aStopInReviewStillHoldsBackLaterStops() {
        // Its End was not accepted, so Start on the next store would be refused (MCP order).
        val route = DailyRoutes.build(listOf(stop("A", 1, "Needs review"), stop("B", 2)), null)
        assertEquals(listOf(StopState.REVIEW, StopState.LATER), route.stops.map { it.state })
        assertNull(route.next)
    }

    @Test fun allDoneHasNoNext() {
        val route = DailyRoutes.build(listOf(stop("A", 1, "Done"), stop("B", 2, "Done")), null)
        assertNull(route.next)
        assertEquals(2, route.done)
    }

    @Test fun distanceNeedsBothAPinAndAPhoneFix() {
        val pinned = stop("A", 1, lat = 14.5764, lng = 121.0851)
        assertNull(DailyRoutes.build(listOf(pinned), null).stops.single().distanceMeters)
        assertNull(DailyRoutes.build(listOf(stop("B", 1, address = "Pasig")), PhonePosition(14.5, 121.0))
            .stops.single().distanceMeters)
        // One hundredth of a degree of latitude is about 1.11 km.
        val meters = DailyRoutes.build(listOf(pinned), PhonePosition(14.5664, 121.0851)).stops.single().distanceMeters!!
        assertEquals(1112.0, meters, 2.0)
    }

    @Test fun formatsDistanceForAGlance() {
        assertEquals("10 m", DailyRoutes.formatDistance(3.0))
        assertEquals("80 m", DailyRoutes.formatDistance(78.0))
        assertEquals("950 m", DailyRoutes.formatDistance(949.0))
        assertEquals("1.2 km", DailyRoutes.formatDistance(1_180.0))
        assertEquals("9.9 km", DailyRoutes.formatDistance(9_930.0))
        assertEquals("34 km", DailyRoutes.formatDistance(34_400.0))
    }

    @Test fun navigationPrefersVerifiedPinThenAddressThenNothing() {
        assertEquals("geo:14.576400,121.085100?q=14.576400,121.085100(Aling%20Nena%20%26%20Sons)",
            DailyRoutes.navigationUri(stop("Aling Nena & Sons", 1, lat = 14.5764, lng = 121.0851, address = "ignored")))
        assertEquals("geo:0,0?q=12%20Rizal%20Ave%2C%20Pasig",
            DailyRoutes.navigationUri(stop("B", 1, address = "12 Rizal Ave, Pasig")))
        assertNull(DailyRoutes.navigationUri(stop("C", 1, address = " ")))
        assertNull(DailyRoutes.navigationUri(stop("D", 1, lat = 14.5)))
    }

    @Test fun cachedOutletAndCustomerRowsFeedTheRouteFacts() {
        val row = com.sunpride.field.storage.SnapshotItem("plan-1",
            """{"id":"plan-1","outletId":"o1","intents":["merchandise"],"sequence":2}""", "2026-10-04", 0)
        val outlets = mapOf("o1" to JSONObject("""{"id":"o1","name":"Nena Store","routeId":null,"code":"OUT-1",
            "customerId":"c1","address":"12 Rizal Ave","latitude":14.5,"longitude":121.0}"""))
        val full = com.sunpride.field.ui.plannedVisitDisplay(row, outlets, mapOf("c1" to "LOCAL-C"))
        assertEquals(listOf("Nena Store", "OUT-1", "LOCAL-C", "12 Rizal Ave"),
            listOf(full.outlet, full.outletCode, full.customerCode, full.address))
        assertEquals(14.5, full.latitude!!, 0.0)
        assertEquals(2, full.sequence)
        // Older server: no route facts. Half a pin is not a pin.
        val bare = com.sunpride.field.ui.plannedVisitDisplay(row,
            mapOf("o1" to JSONObject("""{"id":"o1","name":"Nena Store","routeId":null,"latitude":14.5}""")), emptyMap())
        assertNull(bare.latitude); assertNull(bare.longitude); assertNull(bare.outletCode); assertNull(bare.customerCode)
        assertEquals("Outlet unavailable", com.sunpride.field.ui.plannedVisitDisplay(row, emptyMap(), emptyMap()).outlet)
    }

    @Test fun onlyAValidFixBecomesAPosition() {
        assertNull(positionOf(null))
        assertNull(positionOf(JSONObject().put("latitude", 91).put("longitude", 0)))
        assertNull(positionOf(JSONObject().put("latitude", 14.5)))
        assertTrue(positionOf(JSONObject().put("latitude", 14.5).put("longitude", 121.0)) == PhonePosition(14.5, 121.0))
    }
}
