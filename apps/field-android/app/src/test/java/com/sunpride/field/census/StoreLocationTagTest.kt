package com.sunpride.field.census

import com.sunpride.field.storage.StoreScope
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class StoreLocationTagTest {
    private val at = 1_800_000_000_000L
    private fun fix(accuracy: Double = 70.0, lat: Double = 10.0, time: Long = at) = JSONObject()
        .put("latitude", lat).put("longitude", 123.0).put("accuracyMeters", accuracy)
        .put("fixTime", time).put("mockSignal", false).put("provider", "gps")
    @Test fun missingReadingIsNotARequiredSaveFieldAndSessionSurvivesSerialization() {
        val s = StoreLocationTag.start("00000000-0000-4000-8000-000000000001", null, null, at)
        assertNull(s.optJSONObject("best"))
        assertTrue(StoreLocationTag.active(JSONObject(s.toString()), at + 60_000))
        assertFalse(StoreLocationTag.active(s, at + StoreLocationTag.WINDOW))
        assertFalse(StoreLocationTag.accept(s, fix(time = at + StoreLocationTag.WINDOW), at + StoreLocationTag.WINDOW))
    }
    @Test fun retainsOnlyBetterGenuineGpsAndStopsAtGoodFix() {
        val s = StoreLocationTag.start(null, "00000000-0000-4000-8000-000000000001", null, at)
        assertFalse(StoreLocationTag.accept(s, fix().put("provider", "network"), at))
        assertFalse(StoreLocationTag.accept(s, fix().put("mockSignal", true), at))
        assertFalse(StoreLocationTag.accept(s, fix(time = at - 120_001), at))
        assertTrue(StoreLocationTag.accept(s, fix(), at))
        assertFalse(StoreLocationTag.accept(s, fix(100.0), at))
        assertTrue(StoreLocationTag.accept(s, fix(30.0), at))
        assertTrue(StoreLocationTag.accept(s, fix(10.0), at))
        assertEquals(10.0, s.getJSONObject("best").getDouble("accuracyMeters"), 0.0)
        assertFalse(StoreLocationTag.active(s, at + 1))
    }
    @Test fun leavingStoreOrDrivingStopsWithoutAttachingWrongPoint() {
        val s = StoreLocationTag.start(null, "store", fix(), at)
        assertFalse(StoreLocationTag.accept(s, fix(20.0, 10.01), at))
        assertTrue(s.getBoolean("stopped"))
        val moving = StoreLocationTag.start(null, "store", null, at)
        assertFalse(StoreLocationTag.accept(moving, fix().put("speedMetersPerSecond", 9), at))
        assertTrue(moving.getBoolean("stopped"))
    }
    @Test fun laterEvidenceHasItsOwnImmutableIdAndOriginalCaptureDependency() {
        val capture = "00000000-0000-4000-8000-000000000001"
        val s = StoreLocationTag.start(capture, null, null, at)
        val intent = StoreLocationTag.intent(StoreScope("person", "phone", "scope"), s, fix(), at)
        val op = JSONObject(intent.serializedOperation)
        assertEquals(StoreLocationTag.KIND, op.getString("kind"))
        assertNotEquals(capture, intent.requestId)
        assertEquals(capture, op.getJSONArray("dependsOn").getString(0))
        assertEquals(capture, op.getJSONObject("payload").getString("captureId"))
        assertFalse(op.getJSONObject("payload").has("outletId"))
    }
}
