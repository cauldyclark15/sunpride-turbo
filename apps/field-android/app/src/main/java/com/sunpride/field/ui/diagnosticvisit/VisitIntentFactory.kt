package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** Local dependency reference is resolved to the check-in's server entityId only after durable ack. */
object VisitIntentFactory {
    fun create(scope: StoreScope, kind: String, clientVisitId: String?, checkInRequestId: String?,
        previousRequestId: String?, plannedVisitId: String?, outletId: String, intents: List<String>,
        unplannedReason: String?, note: String?, outcome: String?, reasonCode: String?,
        location: JSONObject?, at: Long = System.currentTimeMillis(),
        uuid: () -> String = { UUID.randomUUID().toString() },
        callSheet: JSONObject? = null, activity: JSONObject? = null): IntentRow {
        require(kind in setOf("visit.checkIn", "visit.activity", "visit.checkOut"))
        val id = uuid().lowercase(); require(UUID.fromString(id).toString() == id)
        val visit = clientVisitId ?: uuid().lowercase()
        val payload = JSONObject()
        if (kind == "visit.checkIn") {
            require(outletId.isNotBlank() && (plannedVisitId != null || !unplannedReason.isNullOrBlank()))
            payload.put("clientVisitId", visit).put("plannedVisitId", plannedVisitId ?: JSONObject.NULL)
                .put("outletId", outletId).put("serviceDate", Instant.ofEpochMilli(at).atZone(ZoneId.of("Asia/Manila")).toLocalDate().toString())
                .put("deviceTime", at).put("location", location ?: JSONObject.NULL)
                .put("intents", JSONArray(intents))
            if (plannedVisitId == null) payload.put("unplannedReason", unplannedReason!!.trim().take(500))
        } else {
            require(!checkInRequestId.isNullOrBlank() && !previousRequestId.isNullOrBlank())
            // This value is a LOCAL template reference, never transmitted as a server visitId.
            payload.put("visitId", "@checkin:$checkInRequestId").put("deviceTime", at)
            if (kind == "visit.activity") {
                if (callSheet != null) {
                    require(callSheet.getString("kind") == "call_sheet")
                    payload.put("activity", callSheet)
                } else if (activity != null) {
                    // AND-013 structured form, already built by ActivityForms (re-validated in the store).
                    require(activity.getString("kind") in setOf("merchandising", "promotion", "inventory_check", "price_check"))
                    payload.put("activity", JSONObject(activity.toString()))
                } else {
                    require(!note.isNullOrBlank())
                    payload.put("activity", JSONObject().put("kind", "note").put("text", note.trim().take(500)))
                }
            } else {
                com.sunpride.field.storage.VisitCallRules.requireOutcome(outcome, reasonCode)
                payload.put("outcome", outcome).put("reasonCode", reasonCode ?: JSONObject.NULL)
                    .put("location", location ?: JSONObject.NULL)
            }
        }
        val op = JSONObject().put("kind", kind).put("clientRequestId", id)
        if (kind != "visit.checkIn") op.put("dependsOn", JSONArray().put(previousRequestId))
        op.put("payload", payload)
        return IntentRow(scope.account, scope.deviceId, scope.fingerprint, id, visit, kind, op.toString(), at)
    }
}
