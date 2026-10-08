package com.sunpride.van.storage

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.van.data.PushAck
import com.sunpride.van.data.PushResult
import com.sunpride.van.location.LocationFix
import com.sunpride.van.location.LocationPingCodec
import com.sunpride.van.sync.FakeVanBackend
import com.sunpride.van.sync.VanSync
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import java.util.UUID

/** SP-0137 against the real encrypted Room store: pings only while the trip is on the road, gated upload, stop once. */
@RunWith(AndroidJUnit4::class)
class LocationPingStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private lateinit var db: VanDatabase
    private lateinit var name: String
    private val scope = StoreScope("https://test.invalid|location-seller","location-device")
    private val s = scope.fullAuthSubject; private val d = scope.deviceId
    private var now = 1_791_338_400_000L
    private lateinit var store: RoomVanStore
    private lateinit var pings: LocationPingStore

    private fun fix(after: Long, north: Double = 0.0, speed: Double? = 0.0) =
        LocationFix(1_791_338_400_000L+after,10.3157+north,123.8854,12.0,speed,null,"gps",false)

    private suspend fun bootstrap(status: String) {
        val o = JSONObject(FakeVanBackend.FIXTURE)
        o.getJSONObject("trip").put("status",status).put("routeSessionId",if (status == "active") "test-route" else JSONObject.NULL)
        if (status == "loaded" || status == "active") o.getJSONObject("load").put("status","posted")
        store.replaceBootstrap(o.toString())
    }

    @Before fun setup() {
        name = "van-location-test-${UUID.randomUUID()}.db"
        db = EncryptedVanDatabase.openWithPassphrase(context,"test-only-location-sqlcipher-key".toByteArray(),name)
        store = RoomVanStore(db,scope,clock = { now })
        pings = store.locations
    }
    @After fun cleanup() { db.close(); context.deleteDatabase(name) }

    @Test fun nothingIsRecordedBeforeTheTripStartsThenStartIsTheFirstPing() = runBlocking {
        bootstrap("loaded")
        assertEquals(LocationPingStore.Outcome.NotOnTrip,pings.record(fix(0),80))
        assertTrue(db.rows().locationPingRows(s,d).isEmpty())
        store.startTrip(true,true,null,null,null,null)
        val first = pings.record(fix(1_000),80)
        assertEquals("start",(first as LocationPingStore.Outcome.Recorded).trigger)
        assertEquals(LocationPingStore.Outcome.Skipped,pings.record(fix(5_000),80))
        assertEquals("moving",(pings.record(fix(20_000,north = 0.0006),null) as LocationPingStore.Outcome.Recorded).trigger)
        assertEquals("still",(pings.record(fix(320_001,north = 0.0006),null) as LocationPingStore.Outcome.Recorded).trigger)
        val rows = db.rows().locationPingRows(s,d).sortedBy { it.recordedAt }
        assertEquals(listOf("start","moving","still"),rows.map { it.pingTrigger })
        // Frozen wire JSON carries the trip and the battery level as captured.
        val json = JSONObject(rows[0].pingJson)
        assertEquals(rows[0].tripId,json.getString("tripId")); assertEquals(80,json.getInt("batteryPercent")); assertEquals("start",json.getString("trigger"))
        assertEquals(3,pings.pendingCount.first())
    }

    @Test fun uploadWaitsUntilTheOfficeHasTheTripStart() = runBlocking {
        bootstrap("loaded")
        val startId = store.startTrip(true,true,null,null,null,null)
        pings.record(fix(1_000),70)
        assertTrue("start not acknowledged yet: the server would refuse trip_not_active",pings.pending().isEmpty())
        val op = checkNotNull(db.rows().outbox(s,d,startId))
        store.recordResult(op,PushResult("trip.start",startId,"accepted",PushAck(op.tripId,null,now)))
        assertEquals(1,pings.pending().size)
        store.hold()
        assertTrue("a held partition sends nothing",pings.pending().isEmpty())
    }

    @Test fun closingTheTripEndsRecordingAndStopIsRecordedOnce() = runBlocking {
        bootstrap("active")
        pings.record(fix(0),60)
        val trip = checkNotNull(db.rows().trip(s,d))
        db.rows().insertTripClose(TripCloseRow(s,d,UUID.randomUUID().toString(),trip.tripId,UUID.randomUUID().toString(),"[]",true,null,null,0,now))
        assertFalse(pings.onRoad())
        assertEquals(LocationPingStore.Outcome.NotOnTrip,pings.record(fix(400_000),60))
        now += 60_000
        val stop = pings.recordStop(null,55)
        assertNotNull(stop)
        assertNull("only one stop per run of pings",pings.recordStop(null,55))
        val rows = db.rows().locationPingRows(s,d).sortedBy { it.recordedAt }
        assertEquals(listOf("start","stop"),rows.map { it.pingTrigger })
        assertEquals(now,rows[1].recordedAt); assertEquals(rows[0].latitude,rows[1].latitude,0.0)
    }

    @Test fun nothingSharedMeansNoStop() = runBlocking {
        bootstrap("active")
        assertNull(pings.recordStop(fix(0),50))
        assertTrue(db.rows().locationPingRows(s,d).isEmpty())
    }

    @Test fun resultsDeleteAcknowledgedKeepRefusedUntilPruneAndScopesStayApart() = runBlocking {
        bootstrap("active")
        pings.record(fix(0),50); pings.record(fix(600_000),50); pings.record(fix(1_200_000),50)
        val batch = pings.pending()
        assertEquals(3,batch.size)
        pings.recordResults(batch.mapIndexed { i,row -> row to LocationPingCodec.Result(row.clientPingId,listOf("accepted","duplicate","rejected")[i],if (i == 2) "too_frequent" else null) })
        val left = db.rows().locationPingRows(s,d)
        assertEquals(listOf("rejected"),left.map { it.status }); assertEquals("too_frequent",left.single().rejectionCode)
        assertTrue("refused pings are never resent",pings.pending().isEmpty())
        // Another person on this phone never sees these pings.
        val other = RoomVanStore(db,StoreScope("https://test.invalid|someone-else",d))
        assertTrue(other.locations.pending().isEmpty())
        pings.prune()
        assertTrue(db.rows().locationPingRows(s,d).isEmpty())
    }

    @Test fun pingsOlderThanSevenDaysAreDropped() = runBlocking {
        bootstrap("active")
        pings.record(fix(0),50)
        now += 8L*24*3_600_000
        pings.prune()
        assertTrue(db.rows().locationPingRows(s,d).isEmpty())
    }

    @Test fun syncSendsPingsThroughThePracticeGatewayAfterTheOperations() = runBlocking {
        bootstrap("loaded")
        store.startTrip(true,true,null,null,null,null)
        pings.record(fix(1_000),90)
        // The practice gateway first applies trip.start, then accepts the truck's ping.
        val backend = FakeVanBackend(JSONObject(FakeVanBackend.FIXTURE).apply {
            getJSONObject("trip").put("status","loaded"); getJSONObject("load").put("status","posted")
        }.toString())
        VanSync(store,backend,clock = { now }).syncNow()
        assertTrue(db.rows().locationPingRows(s,d).isEmpty())
        assertEquals("synced",db.rows().meta(s,d)?.health)
    }
}
