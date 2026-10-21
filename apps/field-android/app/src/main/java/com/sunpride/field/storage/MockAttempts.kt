package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** F-221: an independent telemetry intent, not a visit/check-in, with no mock coordinates retained. */
object MockAttempts {
 const val KIND="integrity.checkInRefused"
 fun create(scope: StoreScope,outletId: String,at: Long):IntentRow {
  UUID.fromString(outletId);require(at>0)
  val id=UUID.randomUUID().toString()
  val p=JSONObject().put("outletId",outletId).put("deviceTime",at).put("mockSignal",true)
  val op=JSONObject().put("kind",KIND).put("clientRequestId",id).put("dependsOn",JSONArray()).put("payload",p)
  return IntentRow(scope.account,scope.deviceId,scope.fingerprint,id,UUID.randomUUID().toString(),KIND,op.toString(),at)
 }
 fun validate(intent:IntentRow) {
  if(intent.kind!=KIND)return
  val op=JSONObject(intent.serializedOperation);val p=op.getJSONObject("payload")
  require(op.getString("kind")==KIND && op.getString("clientRequestId")==intent.requestId && op.getJSONArray("dependsOn").length()==0)
  require(p.getBoolean("mockSignal") && p.keys().asSequence().toSet()==setOf("outletId","deviceTime","mockSignal"))
  UUID.fromString(p.getString("outletId"));require(p.getLong("deviceTime")==intent.createdAt)
 }
}
