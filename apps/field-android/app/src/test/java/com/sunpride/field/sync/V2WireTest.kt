package com.sunpride.field.sync

import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test

class V2WireTest {
    private fun me() = JSONObject("""{"profile":{"id":"employee"},"device":{"id":"phone"},"scope":{"id":"scope","fingerprint":"fingerprint","epoch":"epoch"}}""")
    @Test fun exactPullShapeAndIndependentProjectionCursor() {
        val p = V2Wire.pull("phone", "scope", "field.sales", JSONObject().put("serviceDate", "2026-10-20"))
        assertEquals(2, p.getInt("version")); assertTrue(p.isNull("since")); assertTrue(p.isNull("pageCursor"))
        assertEquals("field-android", p.getString("app")); assertEquals("field.sales", p.getJSONArray("scopes").getJSONObject(0).getString("projection"))
        assertFalse(p.has("contractVersion"))
    }
    @Test fun operationKeepsUuidTimeDependenciesAndActualVisitId() {
        val old = JSONObject("""{"clientRequestId":"stable-id","kind":"visit.activity","dependsOn":["start-id"],"payload":{"deviceTime":123,"visitId":"accepted-visit","activity":{"kind":"note","text":"unchanged"}}}""")
        val op = V2Wire.operation(old)
        assertEquals("stable-id", op.getString("clientOpId")); assertEquals(123L, op.getLong("clientTime"))
        assertEquals(old.getJSONObject("payload").toString(), op.getJSONObject("payload").toString())
        assertEquals(old.getJSONArray("dependsOn").toString(), op.getJSONArray("dependsOn").toString())
    }
    @Test fun appliedAndDuplicateMapToSameDurableAck() {
        val ack = JSONObject().put("entityId", "server-visit").put("serverTime", 123).put("eventIds", JSONArray())
        for (status in listOf("applied", "duplicate")) {
            val r = V2Wire.result(JSONObject().put("clientOpId", "same").put("opType", "visit.checkIn").put("status", status).put("ack", ack))
            assertEquals("accepted", r.getString("status")); assertEquals(ack.toString(), r.getJSONObject("ack").toString())
        }
    }
    @Test fun unknownResultNeverBecomesSuccess() {
        assertEquals("new_status", V2Wire.result(JSONObject("""{"clientOpId":"same","opType":"visit.checkIn","status":"new_status"}""")).getString("status"))
    }
    private fun envelope() = JSONObject("""{"version":2,"serverTime":100,"bundles":[{"scopeId":"scope","scopeFingerprint":"fingerprint","projection":"field.bundle","params":{"dayFrom":"2026-10-20"},"authorization":{"epoch":"epoch","expiresAt":1000}}]}""")
    @Test fun scopeEpochAndExpiryAreCheckedBeforeDataIsUsed() {
        val params = JSONObject().put("dayFrom", "2026-10-20")
        assertEquals("scope", V2Wire.bundle(envelope(), me(), "field.bundle", params).getString("scopeId"))
        for (field in listOf("scopeId", "scopeFingerprint", "projection")) {
            val o = envelope(); o.getJSONArray("bundles").getJSONObject(0).put(field, "foreign")
            assertThrows(IllegalStateException::class.java) { V2Wire.bundle(o, me(), "field.bundle", params) }
        }
        val o = envelope(); o.getJSONArray("bundles").getJSONObject(0).getJSONObject("authorization").put("epoch", "retired")
        assertThrows(IllegalStateException::class.java) { V2Wire.bundle(o, me(), "field.bundle", params) }
        val expired = envelope(); expired.getJSONArray("bundles").getJSONObject(0).getJSONObject("authorization").put("expiresAt", 99)
        assertThrows(IllegalStateException::class.java) { V2Wire.bundle(expired, me(), "field.bundle", params) }
    }
    @Test fun v2ErrorsDecodeWithoutLegacyMessage() {
        val error = BootstrapCodec.error("""{"version":2,"serverTime":123,"error":{"code":"scope_withdrawn","retryable":false,"action":"hold","retryAfterMs":null}}""")
        assertEquals("scope_withdrawn", error.code); assertFalse(error.retryable)
    }
}
