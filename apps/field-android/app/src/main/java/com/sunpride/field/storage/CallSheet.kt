package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject

/** Server-owned account/product setup. The service-date week is deliberately not a phone field. */
data class CallSheetHeader(val accountName: String, val address: String?, val buyerName: String?,
    val contactNumber: String?, val accountInCharge: String?, val receivingInCharge: String?,
    val distributorName: String?, val distributorSchedule: String?, val foc: String?, val pricing: String?) {
    fun fields(): List<Pair<String, String?>> = listOf("accountName" to accountName, "address" to address,
        "buyerName" to buyerName, "contactNumber" to contactNumber, "accountInCharge" to accountInCharge,
        "receivingInCharge" to receivingInCharge, "distributorName" to distributorName,
        "distributorSchedule" to distributorSchedule, "foc" to foc, "pricing" to pricing)
}
data class CallSheetProduct(val productId: String, val code: String, val name: String, val uom: String,
    val barcode: String?, val pricing: String?)
data class CallSheet(val outletId: String, val revision: Long, val header: CallSheetHeader,
    val lines: List<CallSheetProduct>)

object CallSheetCodec {
    private fun JSONObject.text(key: String, max: Int = Int.MAX_VALUE): String {
        require(has(key) && get(key) is String) { "Invalid $key" }
        return (get(key) as String).also { require(it.length <= max) }
    }
    private fun JSONObject.nullableText(key: String, max: Int): String? {
        require(has(key)) { "Missing $key" }
        return if (get(key) == JSONObject.NULL) null else text(key, max)
    }
    fun header(o: JSONObject): CallSheetHeader = CallSheetHeader(
        o.text("accountName", 200).also { require(it.isNotEmpty()) }, o.nullableText("address", 200),
        o.nullableText("buyerName", 200), o.nullableText("contactNumber", 200),
        o.nullableText("accountInCharge", 200), o.nullableText("receivingInCharge", 200),
        o.nullableText("distributorName", 200), o.nullableText("distributorSchedule", 200),
        o.nullableText("foc", 200), o.nullableText("pricing", 200))
    fun decode(o: JSONObject): CallSheet {
        val revision = o.get("revision")
        require(revision is Int || revision is Long)
        val lines = o.getJSONArray("lines")
        require(lines.length() <= 100)
        val products = (0 until lines.length()).map { i ->
            val p = lines.getJSONObject(i)
            CallSheetProduct(p.text("productId").also { require(it.isNotEmpty()) }, p.text("code"),
                p.text("name"), p.text("uom"), p.nullableText("barcode", 64), p.nullableText("pricing", 200))
        }
        require(products.map { it.productId }.distinct().size == products.size)
        return CallSheet(o.text("outletId").also { require(it.isNotEmpty()) },
            (revision as Number).toLong().also { require(it >= 1) }, header(o.getJSONObject("header")), products)
    }
    fun encodeHeader(header: CallSheetHeader): JSONObject = JSONObject().apply {
        header.fields().forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
    }
    fun encode(sheet: CallSheet): JSONObject = JSONObject().put("outletId", sheet.outletId)
        .put("revision", sheet.revision).put("header", encodeHeader(sheet.header))
        .put("lines", JSONArray().apply { sheet.lines.forEach { p ->
            put(JSONObject().put("productId", p.productId).put("code", p.code).put("name", p.name)
                .put("uom", p.uom).put("barcode", p.barcode ?: JSONObject.NULL)
                .put("pricing", p.pricing ?: JSONObject.NULL))
        } })
}

/** Shared validation at the enqueue boundary, inside Room's intent/outbox transaction. */
object CallSheetQueueRules {
    suspend fun validate(store: FieldStore, intent: IntentRow) {
        if (intent.kind != "visit.activity") return
        // Only call-sheet activities are checked here; other activities keep their own validation.
        val op = runCatching { JSONObject(intent.serializedOperation) }.getOrNull() ?: return
        val payload = op.optJSONObject("payload") ?: return
        val activity = payload.optJSONObject("activity") ?: return
        if (activity.optString("kind") != "call_sheet") return
        val reference = payload.getString("visitId")
        require(reference.startsWith("@checkin:")) { "A local check-in reference is required" }
        val checkIn = store.intent(reference.removePrefix("@checkin:")) ?: error("Check in first")
        require(checkIn.kind == "visit.checkIn" && checkIn.clientVisitId == intent.clientVisitId)
        val outletId = JSONObject(checkIn.serializedOperation).getJSONObject("payload").getString("outletId")
        val sheet = store.callSheet(outletId) ?: error("No call sheet for this account")
        com.sunpride.field.ui.diagnosticvisit.CallSheetPayload.validate(activity, sheet)
    }
}
