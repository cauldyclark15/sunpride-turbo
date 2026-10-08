package com.sunpride.van.location

import com.sunpride.van.data.Trip
import com.sunpride.van.sync.VanWireFailure
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LocationModelTest {
    private fun resource(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()
    private val cebu = LocationFix(1_760_000_000_000,10.3157,123.8854,10.0,0.0,null,"gps",false)
    private fun at(ms: Long, lat: Double = cebu.latitude, lng: Double = cebu.longitude, speed: Double? = 0.0, accuracy: Double = 10.0) =
        cebu.copy(recordedAt = cebu.recordedAt+ms,latitude = lat,longitude = lng,speedMetersPerSecond = speed,accuracyMeters = accuracy)
    private fun last(fix: LocationFix, trigger: String = "moving") = LastPing(fix.recordedAt,fix.latitude,fix.longitude,trigger)
    /** ~0.001° latitude ≈ 111 m. */
    private val north60m = 60.0/111_195.0

    @Test fun firstFixOfTheTripIsStart() = assertEquals("start",PingCadence.decide(null,cebu))

    @Test fun movingRecordsEverySixtySecondsOrFiftyMetres() {
        val prev = last(cebu)
        assertNull(PingCadence.decide(prev,at(30_000,speed = 5.0,lat = cebu.latitude+10.0/111_195.0)))
        assertEquals("moving",PingCadence.decide(prev,at(60_000,speed = 5.0,lat = cebu.latitude+20.0/111_195.0)))
        // 60 m in 20 s: recorded before the minute is up.
        assertEquals("moving",PingCadence.decide(prev,at(20_000,lat = cebu.latitude+north60m,speed = null)))
    }

    @Test fun stillRecordsEveryFiveMinutes() {
        val prev = last(cebu)
        assertNull(PingCadence.decide(prev,at(60_000)))
        assertNull(PingCadence.decide(prev,at(4*60_000+59_000)))
        assertEquals("still",PingCadence.decide(prev,at(5*60_000)))
    }

    @Test fun neverCloserThanTheServerSpacingOrBackwards() {
        val prev = last(cebu)
        assertNull(PingCadence.decide(prev,at(9_999,lat = cebu.latitude+1.0,speed = 30.0)))
        assertNull(PingCadence.decide(prev,at(-60_000,lat = cebu.latitude+north60m)))
    }

    @Test fun inaccurateFixesAreSkipped() {
        assertNull(PingCadence.decide(null,at(0,accuracy = 501.0)))
        assertNull(PingCadence.decide(null,at(0,accuracy = Double.NaN)))
    }

    @Test fun distanceIsGreatCircle() {
        assertEquals(111_195.0,PingCadence.distanceMeters(10.0,123.0,11.0,123.0),50.0)
        assertEquals(0.0,PingCadence.distanceMeters(10.0,123.0,10.0,123.0),0.0001)
    }

    private fun trip(status: String, startPending: Boolean = false) = Trip("t1","TRIP-1",status,"2026-10-08",null,null,null,null,"truck",null,null,startPending)

    @Test fun tracksOnlyWhileTheTripIsOnTheRoad() {
        assertFalse(TripTracking.tripOnRoad(null,false))
        assertFalse(TripTracking.tripOnRoad(trip("loaded"),false))
        assertTrue(TripTracking.tripOnRoad(trip("loaded",startPending = true),false))
        assertTrue(TripTracking.tripOnRoad(trip("active"),false))
        assertFalse(TripTracking.tripOnRoad(trip("active"),true))
        for (s in listOf("closing","reconciling","closed","review_required","planned","loading")) assertFalse(s,TripTracking.tripOnRoad(trip(s),false))
        assertTrue(TripTracking.shouldTrack(true,trip("active"),false,consented = true,permitted = true))
        assertFalse(TripTracking.shouldTrack(false,trip("active"),false,true,true))
        assertFalse(TripTracking.shouldTrack(true,trip("active"),false,consented = false,permitted = true))
        assertFalse(TripTracking.shouldTrack(true,trip("active"),false,consented = true,permitted = false))
    }

    @Test fun sharingStateTellsTheSellerWhatToDo() {
        assertEquals(SharingState.NOT_ON_TRIP,SharingRules.state(trip("loaded"),false,true,true))
        assertEquals(SharingState.NEEDS_CONSENT,SharingRules.state(trip("active"),false,false,true))
        assertEquals(SharingState.NEEDS_PERMISSION,SharingRules.state(trip("active"),false,true,false))
        assertEquals(SharingState.ON,SharingRules.state(trip("active"),false,true,true))
        assertEquals("Location sharing on",SharingRules.label(SharingState.ON))
        assertEquals("Location sharing off",SharingRules.label(SharingState.NEEDS_CONSENT))
    }

    @Test fun consentSaysWhatWhenWhoAndHowLong() {
        val text = LocationConsentText.POINTS.joinToString(" ")
        listOf("only while your trip is active","supervisors","90 days","notification","battery","faked").forEach { assertTrue(it,text.contains(it)) }
    }

    @Test fun pingMatchesTheFrozenContractAndRequestValidates() {
        val json = JSONObject(LocationPingCodec.ping("44444444-4444-4444-8444-444444444444","trip-1",cebu.copy(speedMetersPerSecond = 4.5,headingDegrees = 85.0),"start",76))
        assertEquals(setOf("clientPingId","recordedAt","latitude","longitude","accuracyMeters","speedMetersPerSecond","headingDegrees","batteryPercent","mockLocation","provider","trigger","tripId"),json.keys().asSequence().toSet())
        assertEquals(76,json.getInt("batteryPercent")); assertEquals("trip-1",json.getString("tripId")); assertFalse(json.getBoolean("mockLocation"))
        // The fixture's pings go through the same request builder.
        val fixture = JSONObject(resource("location-request.json"))
        val pings = fixture.getJSONArray("pings").let { a -> (0 until a.length()).map { a.getJSONObject(it).toString() } }
        val body = JSONObject(String(LocationPingCodec.request(fixture.getString("deviceId"),pings),Charsets.UTF_8))
        assertEquals(fixture.toString(),body.toString())
    }

    @Test fun pingClampsOrNullsOutOfContractValues() {
        val json = JSONObject(LocationPingCodec.ping(LocationPingCodec.newPingId(),"trip-1",cebu.copy(speedMetersPerSecond = -1.0,headingDegrees = 400.0,accuracyMeters = 200_000.0),"moving",120))
        assertTrue(json.isNull("speedMetersPerSecond")); assertTrue(json.isNull("headingDegrees")); assertTrue(json.isNull("batteryPercent"))
        assertEquals(100_000.0,json.getDouble("accuracyMeters"),0.0)
        assertThrows(IllegalArgumentException::class.java) { LocationPingCodec.ping(LocationPingCodec.newPingId(),"trip-1",cebu,"teleport",null) }
        assertThrows(VanWireFailure::class.java) { LocationPingCodec.ping("not-a-uuid","trip-1",cebu,"start",null) }
        assertThrows(IllegalArgumentException::class.java) { LocationFix(1,91.0,0.0,1.0,null,null,"gps",false) }
        assertEquals("unknown",LocationFix.provider("passive"))
    }

    @Test fun responseNeedsExactlyOneResultPerPingInOrder() {
        val text = resource("location-response.json")
        val ids = listOf("44444444-4444-4444-8444-444444444444","55555555-5555-4555-8555-555555555555","66666666-6666-4666-8666-666666666666")
        val results = LocationPingCodec.results(text,ids)
        assertEquals(listOf("accepted","duplicate","rejected"),results.map { it.status })
        assertEquals("too_frequent",results[2].code); assertNull(results[0].code)
        assertThrows(VanWireFailure::class.java) { LocationPingCodec.results(text,ids.take(2)) }
        assertThrows(VanWireFailure::class.java) { LocationPingCodec.results(text,ids.reversed()) }
        assertThrows(VanWireFailure::class.java) { LocationPingCodec.results("{}",ids) }
        assertThrows(VanWireFailure::class.java) { LocationPingCodec.results("not json",ids) }
        assertThrows(IllegalArgumentException::class.java) { LocationPingCodec.request("d",emptyList()) }
    }
}
