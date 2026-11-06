package com.sunpride.van.sync

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.PaymentMethod
import com.sunpride.van.pos.PaymentState
import com.sunpride.van.pos.QuotedPayment
import com.sunpride.van.pos.QuotedSplit
import com.sunpride.van.pos.SplitTenders
import com.sunpride.van.security.PinProofs
import com.sunpride.van.storage.OutboxRow
import com.sunpride.van.storepos.CashKind
import com.sunpride.van.storepos.Supervisor
import com.sunpride.van.storepos.Supervisors
import com.sunpride.van.storepos.TillPayloads
import com.sunpride.van.vanday.AcceptCount
import com.sunpride.van.vanday.CrewMember
import com.sunpride.van.vanday.CrewSwitch
import com.sunpride.van.vanday.LoadAccept
import com.sunpride.van.vanday.SentLine
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
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

    /** What `StoreCheckout`'s queue adds to every till payload. */
    private fun storePayload(p: JSONObject, deviceTime: Long): JSONObject =
        p.put("shiftId", shiftId).put("registerId", registerId).put("modeVersionId", modeVersionId).put("deviceTime", deviceTime)

    private fun supervisorFor(key: ByteArray, overrideKind: String, opId: String, amount: String): JSONObject {
        val supervisor = Supervisor(supervisorId, "Sam Supervisor", pinId, salt, "unused-here")
        return Supervisors.json(supervisor, PinProofs.hmacHex(key, PinProofs.overrideMessage(overrideKind, opId, shiftId, amount, pinId)))
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

        // store.cash: a cash drop approved with the supervisor's PIN.
        val dropId = "6e0a0000-0000-4000-8000-000000000003"
        val drop = storePayload(TillPayloads.cash(CashKind.DROP, 500_000, "safe_drop", "to the safe"), at + 2_000)
            .put("supervisor", supervisorFor(key, CashKind.DROP.overrideKind!!, dropId, "500000"))
        add("store.cash", envelope("store.cash", dropId, drop))
        // store.cash: paid in needs no supervisor.
        add("store.cash.paid_in", envelope("store.cash", "6e0a0000-0000-4000-8000-000000000004",
            storePayload(TillPayloads.cash(CashKind.PAID_IN, 150_000, "change_fund", null), at + 2_500)))

        // store.read x: any time, no supervisor.
        add("store.read.x", envelope("store.read", "6e0a0000-0000-4000-8000-000000000005", storePayload(JSONObject().put("kind", "x"), at + 3_000)))
        // store.read z: supervisor proof for z_reading with amount 0, bound to this op's own id.
        val zId = "6e0a0000-0000-4000-8000-000000000006"
        add("store.read.z", envelope("store.read", zId,
            storePayload(JSONObject().put("kind", "z").put("supervisor", supervisorFor(key, "z_reading", zId, "0")), at + 4_000)))

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

    @Test fun theFixtureTheApiReplaysIsWhatThePhoneSends() {
        val text = canonical(build()) + "\n"
        val file = File("../../api/test/fixtures/phone-ops.json")
        if (System.getenv("PHONE_FIXTURE_WRITE") == "1") file.writeText(text)
        assertEquals("apps/api/test/fixtures/phone-ops.json is out of date: regenerate it (see the class comment)", file.readText(), text)
    }
}
