package com.sunpride.field.sync

import org.json.JSONArray
import org.json.JSONObject

/** The old store DTOs are deliberately unchanged. Only this boundary converts their envelopes to v2. */
data class WireRequest(val path: String, val bytes: ByteArray, val decode: (String) -> String = { it })

object V2Wire {
    const val PULL = "/api/sync/pull"
    const val PUSH = "/api/sync/push"
    const val APP = "field-android"
    fun pull(deviceId: String, scopeId: String, projection: String, params: JSONObject,
        since: String? = null, page: String? = null, limit: Int = 100): JSONObject = JSONObject()
        .put("version", 2).put("app", APP).put("deviceId", deviceId)
        .put("since", since ?: JSONObject.NULL).put("pageCursor", page ?: JSONObject.NULL)
        .put("scopes", JSONArray().put(JSONObject().put("scopeId", scopeId)
            .put("projection", projection).put("params", params))).put("limit", limit)

    fun bundle(o: JSONObject, me: JSONObject, projection: String, params: JSONObject): JSONObject {
        check(o.getInt("version") == 2 && o.getLong("serverTime") > 0)
        val bundles = o.getJSONArray("bundles"); check(bundles.length() == 1)
        val b = bundles.getJSONObject(0); val scope = me.getJSONObject("scope")
        check(b.getString("scopeId") == scope.getString("id") && b.getString("projection") == projection)
        check(b.getString("scopeFingerprint") == scope.getString("fingerprint"))
        val returned = b.getJSONObject("params")
        val asked=params.keys().asSequence().toSet();val echoed=returned.keys().asSequence().toSet()
        // F-209/F-222 optional negotiation: an older server may omit ONLY this new opt-in.
        // It must not issue workforce authority in that case; all original parameters remain exact.
        val omitted=buildSet {
            if(params.opt("includeWorkforce")==true && !returned.has("includeWorkforce")) add("includeWorkforce")
            if(params.opt("schemeEngine")==1 && !returned.has("schemeEngine")) add("schemeEngine")
        }
        check(echoed==asked-omitted && echoed.all { returned.get(it)==params.get(it) })
        if("includeWorkforce" in omitted) check(b.optJSONObject("data")?.optJSONObject("employee")?.has("workforce")!=true)
        if("schemeEngine" in omitted) b.optJSONObject("data")?.optJSONArray("orderTerms")?.let { terms ->
            check((0 until terms.length()).none { terms.getJSONObject(it).has("schemes") })
        }
        val grant = b.getJSONObject("authorization")
        check(grant.getString("epoch") == scope.getString("epoch"))
        check(grant.getLong("expiresAt") > o.getLong("serverTime"))
        return b
    }
    fun bootstrap(legacy: ByteArray, page: Int, me: JSONObject): WireRequest {
        val old = JSONObject(legacy.toString(Charsets.UTF_8)); val params = JSONObject().put("dayFrom", old.getString("dayFrom")).put("includeWorkforce",true).put("schemeEngine",1)
        val device = me.getJSONObject("device").getString("id")
        val request = pull(device, me.getJSONObject("scope").getString("id"), "field.bundle", params,
            page = old.optString("pageCursor").takeIf { it.isNotBlank() })
        return WireRequest(PULL, request.toString().toByteArray()) { text ->
            val o = JSONObject(text); val b = bundle(o, me, "field.bundle", params)
            check(b.getString("mode") == "snapshot" && b.getJSONArray("changes").length() == 0)
            check(b.getBoolean("complete") == !o.getBoolean("hasMore"))
            val data = JSONObject(b.getJSONObject("data").toString())
            // Local capability-negotiation marker, never a workforce permission or server claim.
            data.getJSONObject("employee").put("workforceNegotiated",true)
            check(data.getJSONObject("employee").getString("id") == me.getJSONObject("profile").getString("id"))
            check(data.getJSONObject("scope").getString("fingerprint") == b.getString("scopeFingerprint"))
            // Nullable optional fields in v2 are omitted only at the legacy DTO decoder boundary.
            for (key in listOf("outlets", "plannedVisits")) {
                val rows = data.getJSONArray(key)
                for (i in 0 until rows.length()) {
                    val row = rows.getJSONObject(i)
                    row.keys().asSequence().toList().filter { it != "routeId" && row.isNull(it) }.forEach { row.remove(it) }
                }
            }
            data.put("v2SnapshotId", o.getString("snapshotId"))
            data.put("type", "bootstrap.response").put("contractVersion", 1).put("page", page)
                .put("serverTime", o.getLong("serverTime")).put("nextPageCursor", o.get("nextPageCursor"))
                .put("syncCursor", o.get("nextCursor"))
            val config = data.getJSONObject("appConfig")
            check(config.getLong("offlineLeaseExpiresAt") <= b.getJSONObject("offlineLease").getLong("expiresAt"))
            check(config.getLong("cacheExpiresAt") <= b.getJSONObject("authorization").getLong("expiresAt"))
            data.toString()
        }
    }
    fun operation(old: JSONObject): JSONObject = JSONObject().put("clientOpId", old.getString("clientRequestId"))
        .put("opType", old.getString("kind")).put("clientTime", old.getJSONObject("payload").getLong("deviceTime"))
        .put("dependsOn", old.optJSONArray("dependsOn") ?: JSONArray()).put("payload", old.getJSONObject("payload"))
    fun push(deviceId: String, scopeId: String, operations: JSONArray): JSONObject = JSONObject()
        .put("version", 2).put("app", APP).put("deviceId", deviceId).put("scopeId", scopeId).put("operations", operations)
    fun result(o: JSONObject): JSONObject {
        val status = o.getString("status")
        return JSONObject(o.toString()).put("clientRequestId", o.getString("clientOpId"))
            .put("kind", o.getString("opType")).put("status", if (status in setOf("applied", "duplicate")) "accepted" else status)
    }
    fun visit(path: String, legacy: ByteArray, me: JSONObject): WireRequest {
        val old = JSONObject(legacy.toString(Charsets.UTF_8)); val scope = me.getJSONObject("scope").getString("id")
        val device = old.getString("deviceId")
        if (path.endsWith("/pull")) {
            val params = JSONObject().put("dayFrom", java.time.LocalDate.now(java.time.ZoneId.of("Asia/Manila")).toString()).put("includeWorkforce",true).put("schemeEngine",1)
            val request = pull(device, scope, "field.bundle", params, since = old.getString("cursor"), limit = 50)
            return WireRequest(PULL, request.toString().toByteArray()) { text ->
                val o = JSONObject(text); val b = bundle(o, me, "field.bundle", params)
                check(b.getString("mode") == "delta" && b.getBoolean("complete"))
                JSONObject().put("type", "pull.response").put("contractVersion", 1).put("serverTime", o.getLong("serverTime"))
                    .put("changes", b.getJSONArray("changes")).put("nextCursor", o.getString("nextCursor"))
                    .put("hasMore", o.getBoolean("hasMore")).toString()
            }
        }
        val location = old.optString("type") == "location.request"
        val rows = if (location) old.getJSONArray("pings") else old.getJSONArray("operations")
        val operations = JSONArray()
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            operations.put(if (!location) operation(row) else JSONObject().put("clientOpId", row.getString("clientPingId"))
                .put("opType", "location.record").put("clientTime", row.getLong("recordedAt"))
                .put("dependsOn", JSONArray()).put("payload", row))
        }
        return WireRequest(PUSH, push(device, scope, operations).toString().toByteArray()) { text ->
            val o = JSONObject(text); check(o.getInt("version") == 2)
            val a = o.getJSONArray("results"); check(a.length() == operations.length())
            val results = JSONArray()
            for (i in 0 until a.length()) {
                val r = a.getJSONObject(i); val sent = operations.getJSONObject(i)
                check(r.getString("clientOpId") == sent.getString("clientOpId") && r.getString("opType") == sent.getString("opType"))
                if (r.getBoolean("retryable")) throw BootstrapFailure(BootstrapFailure.Kind.RETRYABLE)
                results.put(if (!location) result(r) else JSONObject().put("clientPingId", r.getString("clientOpId"))
                    .put("status", when (r.getString("status")) { "applied" -> "accepted"; "duplicate", "rejected" -> r.getString("status"); else -> "unsupported" })
                    .put("code", r.opt("code")))
            }
            JSONObject().put("type", if (location) "location.response" else "push.response")
                .put("contractVersion", 1).put("serverTime", o.getLong("serverTime")).put("results", results).toString()
        }
    }
}
