package com.sunpride.van.sync

import android.content.Context
import com.sunpride.van.BuildConfig
import com.sunpride.van.data.*
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.storage.OutboxRow
import org.json.JSONArray
import org.json.JSONObject

/** DEBUG in-process gateway, fixture-only state. Never uses live auth, URLs or the live DB. */
class FakeVanBackend(fixtureJson: String = FIXTURE, context: Context? = null) : VanGateway {
    private val prefs = context?.getSharedPreferences("van_fixture_backend",Context.MODE_PRIVATE)
    private var state = JSONObject(prefs?.getString("state",null) ?: fixtureJson)
    private val replies = JSONObject(prefs?.getString("replies",null) ?: "{}")
    private var time = state.getLong("serverTime")
    init { check(BuildConfig.DEBUG); VanBootstrapCodec.decode(state.toString()) }
    private fun persist() { prefs?.edit()?.putString("state",state.toString())?.putString("replies",replies.toString())?.commit() }
    @Synchronized private fun snapshot(): String {
        time = maxOf(time+1,state.getLong("serverTime")+1); state.put("serverTime",time); persist(); return state.toString()
    }
    override suspend fun bootstrap(): String = snapshot()
    override suspend fun push(operations: List<OutboxRow>): List<PushResult> = operations.map(::apply)
    @Synchronized private fun apply(row: OutboxRow): PushResult {
        val hash = hex(sha256(row.operationJson.toByteArray(Charsets.UTF_8)))
        replies.optJSONObject(row.clientRequestId)?.let { r ->
            if (r.getString("hash") != hash) return PushResult(row.kind,row.clientRequestId,"conflict",code="conflict")
            return PushResult(row.kind,row.clientRequestId,"accepted",PushAck(r.getString("entityId"),if (r.isNull("movementId")) null else r.getString("movementId"),r.getLong("serverTime")))
        }
        val op = JSONObject(row.operationJson); val p = op.getJSONObject("payload")
        val trip = state.optJSONObject("trip") ?: return PushResult(row.kind,row.clientRequestId,"rejected",code="out_of_scope")
        if (trip.getString("tripId") != p.getString("tripId")) return PushResult(row.kind,row.clientRequestId,"rejected",code="out_of_scope")
        var entity = trip.getString("tripId"); var movement: String? = null
        when(row.kind) {
            "trip.start" -> {
                if (trip.getString("status") != "loaded") return PushResult(row.kind,row.clientRequestId,"rejected",code="load_not_posted")
                trip.put("status","active").put("startedAt",++time).put("routeSessionId","stub-route-session")
                listOf("driverName","helperName").forEach { if (p.has(it)) trip.put(it,p.getString(it)) }
            }
            "load.confirm" -> {
                val load = state.getJSONObject("load"); entity = load.getString("loadId")
                val lines = VanBootstrapCodec.objects(load.getJSONArray("lines")); val actuals = VanBootstrapCodec.objects(p.getJSONArray("lines"))
                val differs = lines.any { line -> actuals.single { it.getInt("lineNumber") == line.getInt("lineNumber") }.getString("actualBase").toLong() != line.getString("expectedBase").toLong() }
                lines.forEach { line -> val input = actuals.single { it.getInt("lineNumber") == line.getInt("lineNumber") }; line.put("actualBase",input.getString("actualBase")).put("discrepancyReason",input.opt("reason") ?: JSONObject.NULL) }
                val posted = !differs || !state.getJSONObject("policy").getBoolean("loadDiscrepancyRequiresApproval")
                load.put("status",if(posted) "posted" else "discrepancy")
                if (posted) {
                    movement = "stub-load-${row.clientRequestId}"; trip.put("status","loaded")
                    lines.forEach { line -> updateStock(line.getString("productId"),line.getString("actualBase").toLong(),0) }
                }
            }
            "truck.damage" -> {
                if (trip.getString("status") != "active") return PushResult(row.kind,row.clientRequestId,"rejected",code="conflict")
                val qty = p.getString("quantityBase").toLong(); val product = p.getString("productId")
                val available = VanBootstrapCodec.objects(state.getJSONArray("truckStock")).firstOrNull { it.getString("productId") == product }?.getString("availableBase")?.toLong() ?: 0L
                if (!state.getJSONObject("policy").getBoolean("allowNegativeStock") && available < qty) return PushResult(row.kind,row.clientRequestId,"rejected",code="invalid_request")
                movement = "stub-damage-${row.clientRequestId}"; updateStock(product,-qty,qty)
            }
            else -> return PushResult(row.kind,row.clientRequestId,"rejected",code="invalid_request")
        }
        val ack = PushAck(entity,movement,++time)
        replies.put(row.clientRequestId,JSONObject().put("hash",hash).put("entityId",entity).put("movementId",movement ?: JSONObject.NULL).put("serverTime",ack.serverTime))
        state.put("serverTime",time); persist()
        return PushResult(row.kind,row.clientRequestId,"accepted",ack)
    }
    private fun updateStock(productId: String, available: Long, damaged: Long) {
        val stocks = state.getJSONArray("truckStock")
        val stock = VanBootstrapCodec.objects(stocks).firstOrNull { it.getString("productId") == productId }
            ?: JSONObject().put("productId",productId).put("availableBase","0").put("damagedBase","0").also(stocks::put)
        stock.put("availableBase",Math.addExact(stock.getString("availableBase").toLong(),available).toString())
        stock.put("damagedBase",Math.addExact(stock.getString("damagedBase").toLong(),damaged).toString())
    }
    companion object {
        /** Embedded only to make device DEBUG stub available without test classpath/assets. JVM tests read fixtures in place. */
        val FIXTURE: String = """{
  "type": "van.bootstrap.response",
  "contractVersion": 1,
  "serverTime": 1791338400000,
  "serviceDate": "2026-10-07",
  "seller": {
    "profileId": "k57prof0000000000000000000000001",
    "name": "Juan Dela Cruz"
  },
  "policy": {
    "allowNegativeStock": false,
    "loadDiscrepancyRequiresApproval": true,
    "walkInAllowed": true,
    "loadDiscrepancyReasons": [
      "short_loaded",
      "over_loaded",
      "damaged_at_loading",
      "wrong_item",
      "other"
    ],
    "damageReasons": ["crushed", "leaking", "expired", "spoiled", "other"],
    "voidReasons": ["wrong_items", "wrong_quantity", "wrong_customer", "wrong_payment", "customer_cancelled", "other"],
    "voidApproval": { "required": true, "thresholdMinor": "0", "key": "6Heg4RirM2SuTt_Pjg5QZwyqg_P-Szkdlxli4UBfz1Y" },
    "paymentMethods": [
      {
        "code": "cash",
        "label": "Cash",
        "kind": "cash",
        "referenceRequired": false,
        "referenceLabel": null
      },
      {
        "code": "check",
        "label": "Check",
        "kind": "other",
        "referenceRequired": true,
        "referenceLabel": "Check number"
      },
      {
        "code": "gcash",
        "label": "GCash",
        "kind": "other",
        "referenceRequired": true,
        "referenceLabel": "GCash reference number"
      },
      {
        "code": "bank_transfer",
        "label": "Bank transfer",
        "kind": "other",
        "referenceRequired": true,
        "referenceLabel": "Bank reference number"
      },
      {
        "code": "credit",
        "label": "Credit (charge to account)",
        "kind": "credit",
        "referenceRequired": false,
        "referenceLabel": null
      }
    ]
  },
  "trip": {
    "tripId": "k57trip0000000000000000000000001",
    "tripNumber": "TRIP-20261007-V014-1",
    "status": "loading",
    "serviceDate": "2026-10-07",
    "vehicle": {
      "vehicleId": "k57veh00000000000000000000000001",
      "vehicleCode": "V014",
      "plateNumber": "NBC 1234",
      "name": "Isuzu Elf"
    },
    "route": {
      "routeId": "k57route000000000000000000000001",
      "code": "CEB-MAN-N",
      "name": "Mandaue North"
    },
    "driverName": "Pedro",
    "helperName": null,
    "truckLocationId": "k57loc00000000000000000000000001",
    "routeSessionId": null,
    "startedAt": null
  },
  "load": {
    "loadId": "k57load0000000000000000000000001",
    "status": "planned",
    "lines": [
      {
        "lineNumber": 1,
        "productId": "k57prod0000000000000000000000001",
        "productCode": "SP-PJ-1L",
        "productName": "Pineapple Juice 1L",
        "uomCode": "PC",
        "quantityScale": "1",
        "lotNumber": null,
        "expectedBase": "48",
        "actualBase": null,
        "discrepancyReason": null
      },
      {
        "lineNumber": 2,
        "productId": "k57prod0000000000000000000000002",
        "productCode": "SP-PC-432",
        "productName": "Pineapple Chunks 432g",
        "uomCode": "PC",
        "quantityScale": "1",
        "lotNumber": "LOT-2026-0002",
        "expectedBase": "24",
        "actualBase": null,
        "discrepancyReason": null
      }
    ]
  },
  "truckStock": [],
  "products": [
    {
      "productId": "k57prod0000000000000000000000001",
      "code": "SP-PJ-1L",
      "name": "Pineapple Juice 1L",
      "uomCode": "PC",
      "quantityScale": "1",
      "barcodes": ["4800000000017", "14800000000016"],
      "barcodeUnits": [
        { "barcode": "4800000000017", "uomCode": "PC", "baseQuantity": "1" },
        { "barcode": "14800000000016", "uomCode": "CS", "baseQuantity": "24" }
      ]
    },
    {
      "productId": "k57prod0000000000000000000000002",
      "code": "SP-PC-432",
      "name": "Pineapple Chunks 432g",
      "uomCode": "PC",
      "quantityScale": "1",
      "barcodes": []
    }
  ],
  "customers": [
    {
      "outletId": "k57out00000000000000000000000001",
      "code": "O-1001",
      "name": "Aling Nena Store",
      "address": "A. Soriano Ave, Mandaue",
      "sequence": 1,
      "source": "route",
      "credit": { "termsDays": 30, "availableMinor": "500000" }
    },
    {
      "outletId": "k57out00000000000000000000000002",
      "code": "O-1002",
      "name": "JM Sari-Sari",
      "address": null,
      "sequence": 2,
      "source": "route",
      "credit": null
    },
    {
      "outletId": "k57out00000000000000000000000003",
      "code": "O-2001",
      "name": "Lapu Market Stall 4",
      "address": null,
      "sequence": null,
      "source": "unplanned"
    }
  ]
}
"""
    }
}
