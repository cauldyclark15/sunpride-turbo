package com.sunpride.field.sell.sync

import com.sunpride.field.sell.data.PaymentKind
import com.sunpride.field.sell.data.PaymentMethod
import com.sunpride.field.sell.pos.PaymentState
import com.sunpride.field.sell.pos.QuotedPayment
import com.sunpride.field.sell.pos.QuotedSplit
import com.sunpride.field.sell.pos.SplitTenders
import com.sunpride.field.sell.security.PinProofs
import com.sunpride.field.sell.storage.OutboxRow
import com.sunpride.field.sell.vanday.AcceptCount
import com.sunpride.field.sell.vanday.CrewMember
import com.sunpride.field.sell.vanday.CrewSwitch
import com.sunpride.field.sell.vanday.LoadAccept
import com.sunpride.field.sell.vanday.SentLine
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * IP-INT3: the exact JSON this phone puts on the wire for the operations the API replays in
 * `apps/api/test/phone-roundtrip-van.test.js` and `phone-roundtrip-store.test.js`.
 *
 * Every payload is made by the phone's own serializers ([LoadAccept.payload], [CrewSwitch.payload],
 * [TillPayloads.cash], [Supervisors.json], [SplitTenders.paymentJson]) and wrapped by the same
 * `V2VanCodec.operation` the sync client uses. The result is compared with the committed fixture
 * `apps/api/test/fixtures/phone-ops.json`; a change to any serializer fails here until the fixture is regenerated
 * (`PHONE_FIXTURE_WRITE=1 ./gradlew :app:testDevDebugUnitTest --tests '*PhoneRoundTripFixtureTest*'`) and the API test
 * passes against it. The PIN is a throw-away test PIN, not a credential.
 */
class PhoneRoundTripFixtureTest {
    private val pin = "246810"
    private val salt = "00112233445566778899aabbccddeeff"
    private val pinId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0001"
    private val supervisorId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0002"
    private val deviceId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0003"
    private val tripId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0004"
    private val loadId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0005"
    private val productId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0006"
    private val helperId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0007"
    private val shiftId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0008"
    private val registerId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0009"
    private val modeVersionId = "5b1d1b52-6b0a-4c1e-9f86-0a1d6b1e0010"
    private val at = 1_793_000_000_000L

    private fun envelope(kind: String, id: String, payload: JSONObject): JSONObject {
        val operation = JSONObject().put("kind", kind).put("clientRequestId", id).put("payload", payload).toString()
        return V2VanCodec.operation(OutboxRow("subject", deviceId, id, tripId, kind, operation, payload.getLong("deviceTime")))
    }

    private fun canonical(v: Any?, indent: String = ""): String = when (v) {
        is JSONObject -> if (v.length() == 0) "{}" else v.keys().asSequence().sorted().joinToString(",\n", "{\n", "\n$indent}") { k -> "$indent  ${JSONObject.quote(k)}: ${canonical(v.get(k), "$indent  ")}" }
        is JSONArray -> if (v.length() == 0) "[]" else (0 until v.length()).joinToString(",\n", "[\n", "\n$indent]") { "$indent  ${canonical(v.get(it), "$indent  ")}" }
        JSONObject.NULL, null -> "null"
        is String -> JSONObject.quote(v)
        else -> v.toString()
    }

    private fun build(): JSONObject {
        val key = PinProofs.derive(pin, salt)
        val keyHex = key.joinToString("") { "%02x".format(it.toInt() and 255) }
        val ops = JSONArray()
        fun add(name: String, e: JSONObject) { ops.put(JSONObject().put("name", name).put("op", e)) }

        // load.accept: the seller counted what the clerk sent (24 PC of one product), same as sent.
        val sent = SentLine(productId, "SP-LG", "Longganisa 500g", null, null, null, 12, 24, null, false)
        val counts = mapOf(sent.key to AcceptCount(24))
        add("load.accept", envelope("load.accept", "6e0a0000-0000-4000-8000-000000000001",
            LoadAccept.payload(tripId, loadId, listOf(sent), counts, "Counted with the clerk", at)))

        // crew.switch: the helper takes over the phone with their PIN.
        val helper = CrewMember(helperId, "Hana Helper", "helper", pinId, salt, "unused-here")
        val switchAt = at + 1_000
        val proof = PinProofs.hmacHex(key, PinProofs.crewMessage(deviceId, tripId, helper.profileId, pinId, switchAt))
        add("crew.switch", envelope("crew.switch", "6e0a0000-0000-4000-8000-000000000002", CrewSwitch.payload(tripId, helper, proof, switchAt)))

        // SP-0192: the store.cash / store.read entries are store mode (Van app only); the Field app builds the van ones.

        // sale.record payment: cash 75.25 (handed over 100.00, change 24.75) + GCash 50.00, for a 125.25 sale.
        val cash = QuotedPayment(PaymentMethod.CASH, 7_525, 10_000, 2_475, null, PaymentState.PAID, null)
        val gcash = QuotedPayment(PaymentMethod("gcash", "GCash", PaymentKind.OTHER, true, "GCash reference number"), 5_000, null, 0, "GC-77821", PaymentState.AWAITING_CONFIRMATION, null)
        val salePayment = SplitTenders.paymentJson(12_525, QuotedSplit(cash, gcash))

        val out = JSONObject().put("note", "Generated by PhoneRoundTripFixtureTest from the phone's own serializers. Do not edit by hand.")
            .put("test", JSONObject().put("pin", pin).put("salt", salt).put("keyHex", keyHex).put("pinId", pinId).put("supervisorId", supervisorId)
                .put("deviceId", deviceId).put("tripId", tripId).put("loadId", loadId).put("productId", productId).put("helperId", helperId)
                .put("shiftId", shiftId).put("registerId", registerId).put("modeVersionId", modeVersionId))
            .put("ops", ops).put("splitSalePayment", salePayment).put("splitSaleTotalMinor", "12525")
        key.fill(0)
        return out
    }

    /** SP-0192: every van entry the Field app's copy builds is exactly the server fixture's entry of the same name (store entries stay Van-only). */
    @Test fun theVanOpsTheApiReplaysAreWhatTheFieldPhoneSends() {
        val mine = build()
        val server = JSONObject(File("../../api/test/fixtures/phone-ops.json").readText())
        val theirs = server.getJSONArray("ops").let { a -> (0 until a.length()).associate { a.getJSONObject(it).getString("name") to a.getJSONObject(it).getJSONObject("op") } }
        val ops = mine.getJSONArray("ops")
        assertTrue(ops.length() >= 2)
        for (i in 0 until ops.length()) {
            val o = ops.getJSONObject(i)
            assertEquals(o.getString("name"), canonical(theirs.getValue(o.getString("name"))), canonical(o.getJSONObject("op")))
        }
        assertEquals(canonical(server.get("splitSalePayment")), canonical(mine.get("splitSalePayment")))
        assertEquals(canonical(server.getJSONObject("test")), canonical(mine.getJSONObject("test")))
    }
}
