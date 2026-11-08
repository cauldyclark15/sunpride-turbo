package com.sunpride.field.census

import com.sunpride.field.auth.AuthFailure
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.UUID

/** SP-0163 address search and duplicate check through OUR API proxy (/api/v1/places/...). The phone never holds a
 * Google key. Every call degrades: an older server (404), a missing key (503) or no signal never block a capture. */
class CensusPlaces(private val get: (String) -> JSONObject, private val post: (String, JSONObject) -> JSONObject) {
    sealed class Result<out T> {
        data class Ok<T>(val value: T) : Result<T>()
        /** No internet: say so in plain words. */
        data object Offline : Result<Nothing>()
        /** Server does not offer it (old server, not set up, nothing found, rate limited). */
        data object Unavailable : Result<Nothing>()
    }
    data class Prediction(val placeId: String, val primary: String, val secondary: String, val description: String)
    data class Components(val street: String?, val barangay: String?, val city: String?, val province: String?,
        val region: String?, val postalCode: String?) {
        fun json(): JSONObject = JSONObject().apply {
            listOf("street" to street, "barangay" to barangay, "city" to city, "province" to province,
                "region" to region, "postalCode" to postalCode).forEach { (k, v) -> if (v != null) put(k, v.take(120)) }
        }
        /** "Barangay, City" line under the address. */
        fun line(): String = listOfNotNull(barangay, city).joinToString(", ")
    }
    data class Address(val formattedAddress: String, val components: Components, val placeId: String? = null,
        val latitude: Double? = null, val longitude: Double? = null)

    private fun <T> call(block: () -> T): Result<T> = try { Result.Ok(block()) } catch (e: AuthFailure) {
        if (e.kind == AuthFailure.Kind.OFFLINE) Result.Offline else Result.Unavailable
    } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { Result.Unavailable }

    fun autocomplete(input: String, session: String, latitude: Double?, longitude: Double?): Result<List<Prediction>> {
        val text = input.trim()
        if (text.length !in 3..120) return Result.Ok(emptyList())
        val bias = if (latitude != null && longitude != null) "&lat=$latitude&lng=$longitude" else ""
        return call {
            val a = get("/api/v1/places/autocomplete?input=${enc(text)}&session=${enc(session)}$bias").optJSONArray("predictions") ?: JSONArray()
            (0 until minOf(5, a.length())).map { a.getJSONObject(it) }.filter { it.optString("placeId").isNotEmpty() }.map {
                Prediction(it.getString("placeId"), it.optString("primary"), it.optString("secondary"), it.optString("description"))
            }
        }
    }

    fun details(placeId: String, session: String): Result<Address> = call {
        val o = get("/api/v1/places/details?placeId=${enc(placeId)}&session=${enc(session)}")
        val lat = o.getDouble("latitude"); val lng = o.getDouble("longitude")
        require(lat.isFinite() && lat in -90.0..90.0 && lng.isFinite() && lng in -180.0..180.0)
        Address(o.getString("formattedAddress"), components(o.optJSONObject("components")), o.optString("placeId", placeId), lat, lng)
    }

    fun reverse(latitude: Double, longitude: Double): Result<Address> = call {
        val o = get("/api/v1/places/reverse?lat=$latitude&lng=$longitude")
        Address(o.getString("formattedAddress"), components(o.optJSONObject("components")))
    }

    fun duplicateCheck(name: String, phone: String?, latitude: Double?, longitude: Double?, placeId: String?): Result<List<DuplicateRules.Candidate>> = call {
        val body = JSONObject().put("name", name)
        if (!phone.isNullOrBlank()) body.put("phone", phone)
        if (latitude != null && longitude != null) body.put("latitude", latitude).put("longitude", longitude)
        if (!placeId.isNullOrBlank()) body.put("placeId", placeId)
        val a = post("/api/v1/masters/census/duplicate-check", body).optJSONArray("candidates") ?: JSONArray()
        (0 until a.length()).map { a.getJSONObject(it) }.map {
            val reasons = it.optJSONArray("reasons")?.let { r -> (0 until r.length()).map(r::getString) }.orEmpty()
            DuplicateRules.Candidate(it.optString("kind", "outlet"), it.getString("id"), it.optString("name"),
                it.text("address"), it.num("latitude"), it.num("longitude"), it.num("distanceMeters"), reasons, it.optInt("score"))
        }
    }

    companion object {
        fun session(): String = UUID.randomUUID().toString()
        private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
        private fun JSONObject.text(k: String): String? = if (isNull(k)) null else optString(k).trim().takeIf { it.isNotEmpty() }
        private fun JSONObject.num(k: String): Double? = if (isNull(k)) null else (opt(k) as? Number)?.toDouble()?.takeIf { it.isFinite() }
        fun components(o: JSONObject?): Components {
            fun t(k: String) = o?.text(k)
            return Components(t("street"), t("barangay"), t("city"), t("province"), t("region"), t("postalCode"))
        }
    }
}
