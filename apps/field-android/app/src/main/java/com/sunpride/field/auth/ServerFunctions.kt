package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import okhttp3.OkHttpClient
import org.json.JSONObject

/**
 * Named reads and device commands on the Sunpride server. Reads map to signed `/api/sync/pull`
 * projections; device commands use `/api/devices/challenge|bind` with the short-lived access token. [NativeApi]
 * refreshes the access token once on 401. Transport failures are never retried here.
 */
class ServerFunctions(
    private val environment: AppEnvironment,
    private val auth: AuthClient,
    private val http: OkHttpClient = defaultHttpClient()
) {
    fun uploadOrigin(url: String): Boolean = java.net.URI(url).let {
        val origin = java.net.URI(environment.apiOrigin)
        it.scheme == origin.scheme && it.host == origin.host && it.port == origin.port
    }
    val api = NativeApi(environment, auth, http)
    var signer: (() -> com.sunpride.field.device.DeviceSigner)? = null
    fun query(path: String, args: JSONObject): Any? {
        val me = api.me()
        if (me.optBoolean("handoverRequired")) throw ServerError("device_handover_required")
        if (path == "mobile/devices:mine") return me.optJSONObject("device")?.let { d ->
            JSONObject(d.toString()).put("deviceId", d.getString("id"))
        }
        val projection = when (path) {
            "dsr/report:day" -> "field.sales"
            com.sunpride.catalogue.TargetProgressCodec.PATH -> com.sunpride.catalogue.TargetProgressCodec.PROJECTION
            "supervision/mobile:team" -> "team.summary"
            "analytics/suggested_orders:forOutlet" -> "suggested-order"
            else -> throw ServerError("unsupported_projection")
        }
        val device = me.getJSONObject("device").getString("id")
        val request = com.sunpride.field.sync.V2Wire.pull(device, me.getJSONObject("scope").getString("id"), projection, args)
        val response = api.signed(com.sunpride.field.sync.V2Wire.PULL, request, requireNotNull(signer).invoke(), device)
        val bundle = com.sunpride.field.sync.V2Wire.bundle(response, me, projection, args)
        check(bundle.getString("mode") == "snapshot" && bundle.getBoolean("complete") && !response.getBoolean("hasMore"))
        val data=bundle.getJSONObject("data")
        if(projection==com.sunpride.catalogue.TargetProgressCodec.PROJECTION)data.put("expiresAt",minOf(bundle.getJSONObject("authorization").getLong("expiresAt"),bundle.getJSONObject("offlineLease").getLong("expiresAt")))
        return data
    }
    fun mutation(path: String, args: JSONObject): Any? = when (path) {
        "mobile/devices:challenge" -> api.post("/api/devices/challenge", JSONObject(args.toString()).put("version", 2))
        "mobile/devices:bind" -> api.post("/api/devices/bind", JSONObject(args.toString()).put("version", 2))
        else -> throw ServerError("unsupported_operation")
    }

}
