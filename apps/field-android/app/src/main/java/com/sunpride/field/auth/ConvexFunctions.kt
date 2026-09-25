package com.sunpride.field.auth

import com.sunpride.field.AppEnvironment
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * Convex HTTP function API: POST `{CONVEX_URL}/api/query|mutation` with `{path, args, format:"json"}`
 * and the Convex JWT bearer. Success `{status:"success", value}`; failure `{status:"error", errorMessage,
 * errorData?}`. An HTTP 401 means the JWT was rejected before execution, so both queries and mutations
 * are retried exactly once with a freshly exchanged JWT. Transport failures are never retried here.
 */
class ConvexFunctions(
    private val environment: AppEnvironment,
    private val auth: AuthClient,
    private val http: OkHttpClient = defaultHttpClient()
) {
    fun query(path: String, args: JSONObject): Any? = run("query", path, args)
    fun mutation(path: String, args: JSONObject): Any? = run("mutation", path, args)

    private fun run(kind: String, path: String, args: JSONObject): Any? {
        if (!environment.isReady) throw AuthFailure(AuthFailure.Kind.NOT_CONFIGURED)
        val payload = encode(path, args)
        for (attempt in 0..1) {
            val bearer = auth.convexToken(forceRefresh = attempt > 0)
            val request = Request.Builder().url(environment.convexUrl.trimEnd('/') + "/api/$kind")
                .header("Authorization", "Bearer $bearer")
                .post(payload.toRequestBody(JSON_MEDIA)).build()
            try {
                http.newCall(request).execute().use { response ->
                    if (response.code == 401) {
                        auth.invalidateConvexToken()
                        if (attempt == 1) throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
                    } else {
                        // Convex reports function errors with 4xx/5xx *and* a JSON envelope; decode both.
                        val envelope = runCatching { JSONObject(response.body?.string().orEmpty()) }.getOrNull()
                            ?: throw AuthFailure(AuthFailure.Kind.SERVER)
                        return decode(envelope)
                    }
                }
            } catch (_: IOException) {
                throw AuthFailure(AuthFailure.Kind.OFFLINE)
            } catch (_: JSONException) {
                throw AuthFailure(AuthFailure.Kind.SERVER)
            }
        }
        throw AuthFailure(AuthFailure.Kind.SESSION_EXPIRED)
    }

    companion object {
        fun encode(path: String, args: JSONObject): String =
            JSONObject().put("path", path).put("args", args).put("format", "json").toString()

        /** Returns the `value` (JSONObject, JSONArray, primitive or `null`). */
        fun decode(envelope: JSONObject): Any? = when (envelope.optString("status")) {
            "success" -> envelope.opt("value").takeUnless { it == null || it == JSONObject.NULL }
            "error" -> throw ConvexFunctionError(
                (envelope.opt("errorData") as? String)?.takeIf { it.length <= 120 }
            )
            else -> throw AuthFailure(AuthFailure.Kind.SERVER)
        }
    }
}
