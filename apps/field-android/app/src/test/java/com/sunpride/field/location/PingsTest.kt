package com.sunpride.field.location

import com.sunpride.field.storage.FieldStore
import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.LocationPingRow
import com.sunpride.field.storage.StoreScope
import com.sunpride.field.support.FakeFieldStore
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PingsTest {
    private fun fix(lat: Double, lon: Double, time: Long, speed: Double? = null, accuracy: Double = 10.0) =
        Fix(lat, lon, accuracy, speed, null, false, time)

    @Test fun cadenceIsAboutAMinuteWhileMovingAndFiveMinutesWhileStill() {
        val first = fix(10.3157, 123.8854, 0)
        assertEquals("start", PingCadence.decide(null, first))
        // Never closer than the spacing floor, whatever happens.
        assertNull(PingCadence.decide(first, fix(10.3257, 123.8854, 10_000, speed = 12.0)))
        // Moving (speed) — recorded once a minute.
        assertNull(PingCadence.decide(first, fix(10.3158, 123.8854, 40_000, speed = 2.0)))
        assertEquals("moving", PingCadence.decide(first, fix(10.3158, 123.8854, 60_000, speed = 2.0)))
        // 50 m displacement — recorded before the minute is up.
        assertEquals("moving", PingCadence.decide(first, fix(10.3162, 123.8854, 20_000)))
        // Standing still (jitter inside the accuracy radius): only every 5 minutes.
        val jitter = fix(10.31575, 123.88545, 120_000, accuracy = 80.0)
        assertNull(PingCadence.decide(first, jitter))
        assertEquals("still", PingCadence.decide(first, fix(10.31575, 123.88545, 300_000, accuracy = 80.0)))
    }

    @Test fun distanceIsHaversineMetres() {
        val d = PingCadence.distanceMeters(fix(10.3157, 123.8854, 0), fix(10.3166, 123.8854, 0))
        assertTrue(d in 99.0..101.0)
    }

    private fun JSONObject.keyNames(): Set<String> = keys().asSequence().toSet()
    private fun resource(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.bufferedReader().readText()

    @Test fun pingMatchesTheFrozenV1Fixture() {
        val fixture = JSONObject(resource("location-request.json"))
        val wire = fixture.getJSONArray("pings")
        val withVisit = wire.getJSONObject(0)
        val ours = PingCodec.ping(Fix(10.3157, 123.8854, 12.5, 3.2, 90.0, false, 1_760_000_000_000),
            "start", 84, "visit-cebu-001", provider = "gps", clientPingId = withVisit.getString("clientPingId"))
        assertEquals(withVisit.keyNames(), ours.keyNames())
        withVisit.keyNames().forEach { key: String ->
            val expected = withVisit.get(key); val actual = ours.get(key)
            if (expected is Number) assertEquals(key, expected.toDouble(), (actual as Number).toDouble(), 0.0)
            else assertEquals(key, expected.toString(), actual.toString())
        }
        val noVisit = PingCodec.ping(Fix(10.317, 123.887, 20.0, 8.5, 120.0, false, 1L), "moving", null, null)
        assertEquals(wire.getJSONObject(2).keyNames(), noVisit.keyNames())
        assertTrue(noVisit.isNull("batteryPercent"))
        val request = JSONObject(String(PingCodec.request(fixture.getString("deviceId"),
            (0 until wire.length()).map { wire.getJSONObject(it).toString() }), Charsets.UTF_8))
        assertEquals(fixture.keyNames(), request.keyNames())
        assertEquals("location.request", request.getString("type"))
    }

    @Test fun oddSensorValuesAreClampedToTheServerRanges() {
        val p = PingCodec.ping(Fix(10.0, 123.0, Double.NaN, 250.0, 361.0, true, 5), "still", 140, "x".repeat(65))
        assertEquals(100_000.0, p.getDouble("accuracyMeters"), 0.0)
        assertEquals(100.0, p.getDouble("speedMetersPerSecond"), 0.0)
        assertEquals(360.0, p.getDouble("headingDegrees"), 0.0)
        assertEquals(100, p.getInt("batteryPercent"))
        assertTrue(p.getBoolean("mockLocation"))
        assertFalse("a too-long id is dropped, never sent", p.has("visitId"))
        assertTrue(Regex("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
            .matches(p.getString("clientPingId")))
    }

    @Test fun responseParsingFollowsTheFixture() {
        val text = resource("location-response.json")
        val ids = JSONObject(text).getJSONArray("results").let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("clientPingId") } }
        val results = PingCodec.results(text, ids)
        assertEquals(listOf("accepted", "duplicate", "rejected"), results.map { it.status })
        assertEquals("too_frequent", results[2].code)
        assertTrue(runCatching { PingCodec.results(text, ids.reversed()) }.isFailure)
    }

    @Test fun openVisitIsTheDeliveredStartWithoutAnEnd() {
        fun row(id: String, visit: String, kind: String) = IntentRow("a", "d", "s", id, visit, kind, "{}", 1)
        assertNull(OpenVisit.checkInRequestId(listOf(row("r1", "v1", "visit.checkIn") to "pending")))
        assertEquals("r1", OpenVisit.checkInRequestId(listOf(row("r1", "v1", "visit.checkIn") to "done",
            row("r2", "v1", "visit.activity") to "pending")))
        assertNull(OpenVisit.checkInRequestId(listOf(row("r1", "v1", "visit.checkIn") to "done",
            row("r3", "v1", "visit.checkOut") to "pending")))
        assertNull(OpenVisit.serverId("x".repeat(65)))
    }
}

class LocationUploaderTest {
    private val scope = StoreScope("acct", "device-1", "fp")

    private class PingStore(base: FieldStore) : FieldStore by base {
        val rows = mutableListOf<LocationPingRow>()
        var held = false
        override suspend fun pendingPings(limit: Int) = rows.sortedBy { it.recordedAt }.take(limit)
        override suspend fun pendingPingCount() = rows.size
        override suspend fun removePings(ids: List<String>) { rows.removeAll { it.clientPingId in ids } }
        override suspend fun isHeld() = held
    }

    private fun store(count: Int) = PingStore(FakeFieldStore(scope)).also { s ->
        repeat(count) { i ->
            val ping = PingCodec.ping(Fix(10.0, 123.0, 10.0, null, null, false, i * 60_000L), "moving", 50, null)
            s.rows += LocationPingRow("acct", "device-1", "fp", ping.getString("clientPingId"), i * 60_000L, ping.toString())
        }
    }

    private fun answer(body: ByteArray, status: (Int) -> Pair<String, String?> = { "accepted" to null }): String {
        val pings = JSONObject(String(body, Charsets.UTF_8)).getJSONArray("pings")
        val results = org.json.JSONArray()
        for (i in 0 until pings.length()) {
            val (s, code) = status(i)
            results.put(JSONObject().put("clientPingId", pings.getJSONObject(i).getString("clientPingId")).put("status", s)
                .apply { if (code != null) put("code", code) })
        }
        return JSONObject().put("type", "location.response").put("contractVersion", 1).put("serverTime", 1).put("results", results).toString()
    }

    @Test fun uploadsInBatchesOfAHundredAndClearsAnsweredPings() = runBlocking {
        val s = store(230)
        val sizes = mutableListOf<Int>()
        val report = LocationUploader(s, "device-1") { path, body ->
            assertEquals("/mobile/v1/location", path)
            val o = JSONObject(String(body, Charsets.UTF_8))
            assertEquals("device-1", o.getString("deviceId"))
            sizes += o.getJSONArray("pings").length()
            200 to answer(body) { i -> if (i == 0) "rejected" to "too_frequent" else if (i == 1) "duplicate" to null else "accepted" to null }
        }.run()
        assertEquals(listOf(100, 100, 30), sizes)
        assertEquals(0, s.rows.size)
        assertEquals(3, report.refused); assertEquals(227, report.sent); assertFalse(report.retryLater)
    }

    @Test fun offlineOrServerErrorsKeepTheSameBytesForTheRetry() = runBlocking {
        val s = store(3)
        val before = s.rows.map { it.json }
        val offline = LocationUploader(s, "device-1") { _, _ -> throw java.io.IOException("offline") }.run()
        assertTrue(offline.retryLater); assertEquals(3, s.rows.size)
        val busy = LocationUploader(s, "device-1") { _, _ -> 500 to "{}" }.run()
        assertTrue(busy.retryLater); assertEquals(before, s.rows.map { it.json })
        val malformed = LocationUploader(s, "device-1") { _, _ -> 200 to "{\"type\":\"push.response\"}" }.run()
        assertTrue(malformed.retryLater); assertEquals(3, s.rows.size)
        val unauthorized = LocationUploader(s, "device-1") { _, _ -> 401 to "" }.run()
        assertTrue(unauthorized.unauthorized); assertEquals(3, s.rows.size)
        // The retry resends exactly the stored bytes (same clientPingIds → server de-duplicates).
        var resent: List<String> = emptyList()
        LocationUploader(s, "device-1") { _, body ->
            val a = JSONObject(String(body, Charsets.UTF_8)).getJSONArray("pings")
            resent = (0 until a.length()).map { a.getJSONObject(it).toString() }
            200 to answer(body)
        }.run()
        assertEquals(before.map { JSONObject(it).toString() }, resent)
        assertEquals(0, s.rows.size)
    }

    @Test fun aHeldPartitionSendsNothing() = runBlocking {
        val s = store(2).also { it.held = true }
        var calls = 0
        val report = LocationUploader(s, "device-1") { _, _ -> calls++; 200 to "" }.run()
        assertEquals(0, calls); assertEquals(2, report.remaining)
    }

    @Test fun aPermanentShapeRefusalDropsTheBatchInsteadOfLooping() = runBlocking {
        val s = store(2)
        val report = LocationUploader(s, "device-1") { _, _ -> 400 to "{\"error\":{\"code\":\"invalid_request\",\"message\":\"x\",\"retryable\":false}}" }.run()
        assertEquals(2, report.refused); assertEquals(0, s.rows.size)
    }
}
