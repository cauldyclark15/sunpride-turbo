package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Received money is a separate, complete command. Saving unfinished text never calls this factory. */
object VisitCollection {
    const val KIND = "collection.record"
    val METHODS = listOf("cash", "cheque", "bank_transfer", "ewallet")
    fun validate(p: JSONObject) {
        val amount = p.get("amountMinor")
        require((amount is Int || amount is Long) && (amount as Number).toLong() in 1..99_999_999_999L) { "Enter the full amount received" }
        require(p.getString("currency") == "PHP" && p.getString("method") in METHODS)
        require(p.getString("reference").trim().length in 1..200)
        require(p.getString("visitId").startsWith("@checkin:"))
    }
    fun intent(scope: StoreScope, start: IntentRow, previous: String, amount: Long, method: String,
        reference: String, at: Long): IntentRow {
        val id = UUID.randomUUID().toString()
        val p = JSONObject().put("visitId", "@checkin:${start.requestId}").put("amountMinor", amount)
            .put("currency", "PHP").put("method", method).put("reference", reference.trim().ifEmpty { "Collection received" }).put("deviceTime", at)
        validate(p)
        return IntentRow(scope.account, scope.deviceId, scope.fingerprint, id, start.clientVisitId, KIND,
            JSONObject().put("clientRequestId", id).put("kind", KIND).put("dependsOn", JSONArray().put(previous)).put("payload", p).toString(), at)
    }
    suspend fun requireOpen(store: FieldStore, row: IntentRow) {
        if (row.kind != KIND) return
        val p = JSONObject(row.serializedOperation).getJSONObject("payload"); validate(p)
        val start = store.intent(p.getString("visitId").removePrefix("@checkin:")) ?: error("Start the visit first")
        require(start.kind == "visit.checkIn" && start.clientVisitId == row.clientVisitId)
        val rows = store.history().filter { it.first.clientVisitId == row.clientVisitId }.map { it.first to it.second.state }
        require(VisitCallRules.started(rows) && !VisitCallRules.closed(rows)) { "Record the collection during the open visit" }
    }
}
