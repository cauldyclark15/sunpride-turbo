package com.sunpride.field.census

import com.sunpride.field.storage.IntentRow
import com.sunpride.field.storage.StoreScope
import org.json.JSONArray
import org.json.JSONObject
import java.util.Base64
import java.util.UUID

/** F-011 survey capture is a standalone configuration, not another selling flow.
 * Its complete immutable intent (including bounded JPEG) lives in SQLCipher's outbox. */
object CensusRules {
    const val KIND = "census.capture"
    const val MAX_PHOTO_BYTES = 160 * 1024
    val COMPONENTS = setOf("street", "barangay", "city", "province", "region", "postalCode")
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    fun validate(p: JSONObject) {
        // SP-0163: batchId is optional (server files it under the agent's ongoing batch); when sent it must be valid.
        val keys = listOf("captureId", "channelId", "subchannelId") + (if (p.has("batchId") && !p.isNull("batchId")) listOf("batchId") else emptyList())
        keys.forEach { require(uuid.matches(p.getString(it))) { "Choose a valid census batch and channel." } }
        for ((key, max) in listOf("name" to 200, "address" to 500, "ownerName" to 150, "ownerPhone" to 40))
            require(p.getString(key).trim().length in 1..max) { "Complete the store and owner details." }
        require(p.getString("ownerPhone").count { it.isDigit() } >= 7) { "Enter a complete owner phone number." }
        require(p.getString("estimatedClass") in listOf("A", "B", "C", "D"))
        require(p.optString("landmark").length <= 200) { "Keep the landmark under 200 characters." }
        require(p.optString("formattedAddress").length <= 500)
        p.optJSONObject("addressComponents")?.let { c -> c.keys().forEach { k ->
            require(k in COMPONENTS && c.optString(k).length <= 120) } }
        p.optJSONArray("acknowledgedDuplicateIds")?.let { a -> require(a.length() <= 10 && (0 until a.length()).all { a.opt(it) is String }) }
        val at = p.getLong("deviceTime")
        val l = p.getJSONObject("location")
        require(l.getDouble("latitude").isFinite() && l.getDouble("latitude") in -90.0..90.0)
        require(l.getDouble("longitude").isFinite() && l.getDouble("longitude") in -180.0..180.0)
        when (p.optString("locationSource", "gps")) {
            "places" -> require(p.optString("placeId").isNotBlank()) { "Pick the address again from the search list." }
            "gps" -> require(l.getDouble("accuracyMeters") > 0 && l.getDouble("accuracyMeters") < 50 && !l.getBoolean("mockSignal") &&
                l.getString("provider") in listOf("gps", "fused", "network") && kotlin.math.abs(at - l.getLong("fixTime")) <= 120_000) {
                "Get a fresh GPS fix with accuracy under 50 m. Mock locations cannot be used."
            }
            else -> throw IllegalArgumentException("Choose Use my location or Search address.")
        }
        val photo = Base64.getDecoder().decode(p.getString("photoJpegBase64"))
        require(photo.size in 4..MAX_PHOTO_BYTES && photo[0] == 0xff.toByte() && photo[1] == 0xd8.toByte() &&
            photo[photo.size - 2] == 0xff.toByte() && photo.last() == 0xd9.toByte()) { "Take a storefront photo." }
    }
    fun intent(scope: StoreScope, payload: JSONObject, now: Long): IntentRow {
        validate(payload)
        require(kotlin.math.abs(now - payload.getLong("deviceTime")) <= 120_000)
        val id = payload.getString("captureId")
        val operation = JSONObject().put("clientRequestId", id).put("kind", KIND)
            .put("dependsOn", JSONArray()).put("payload", JSONObject(payload.toString()))
        return IntentRow(scope.account, scope.deviceId, scope.fingerprint, id, id, KIND, operation.toString(), now)
    }
    fun captureId(): String = UUID.randomUUID().toString()

    /** Contract 'Phone UX' 4: the batch is optional. Hide the picker until the config is loaded, when no batches
     * are offered (the server files the capture under the unit's ongoing default batch), or when the server has a
     * default batch and there is at most one batch to choose from. */
    fun showBatchPicker(config: JSONObject?): Boolean {
        if (config == null) return false
        val count = config.optJSONArray("batches")?.length() ?: 0
        if (count == 0) return false
        val hasDefault = config.optJSONObject("defaultBatch")?.optString("id")?.isNotEmpty() == true
        return !(hasDefault && count <= 1)
    }
    /** The batchId to send: the agent's choice when the picker is shown and something was chosen, else none. */
    fun chosenBatch(showPicker: Boolean, chosen: String?): String? = chosen?.trim()?.takeIf { showPicker && it.isNotEmpty() }
    /** Search address only when the server says the proxy is configured; absent field (old server) = hidden. */
    fun addressSearch(config: JSONObject?): Boolean = config?.optBoolean("addressSearch", false) == true

    data class Place(val placeId: String, val latitude: Double, val longitude: Double, val formattedAddress: String?,
        val components: JSONObject?)

    /** One payload for both location choices (contract census.capture changes). [batchId] null = server default batch. */
    fun payload(captureId: String, batchId: String?, name: String, address: String, ownerName: String, ownerPhone: String,
        channelId: String, subchannelId: String, estimatedClass: String, deviceTime: Long, gpsFix: JSONObject?, place: Place?,
        landmark: String, reverse: Pair<String, JSONObject?>?, acknowledged: List<String>, photo: String): JSONObject {
        val p = JSONObject().put("captureId", captureId).put("name", name.trim()).put("address", address.trim())
            .put("ownerName", ownerName.trim()).put("ownerPhone", ownerPhone.trim()).put("channelId", channelId)
            .put("subchannelId", subchannelId).put("estimatedClass", estimatedClass).put("deviceTime", deviceTime)
            .put("photoJpegBase64", photo)
        if (!batchId.isNullOrEmpty()) p.put("batchId", batchId)
        if (place != null) {
            p.put("locationSource", "places").put("placeId", place.placeId)
                .put("location", JSONObject().put("latitude", place.latitude).put("longitude", place.longitude))
            place.formattedAddress?.let { p.put("formattedAddress", it.take(500)) }
            place.components?.takeIf { it.length() > 0 }?.let { p.put("addressComponents", it) }
        } else {
            p.put("locationSource", "gps").put("location", gpsFix ?: JSONObject.NULL)
            reverse?.let { (formatted, components) ->
                p.put("formattedAddress", formatted.take(500))
                components?.takeIf { it.length() > 0 }?.let { p.put("addressComponents", it) }
            }
        }
        landmark.trim().takeIf { it.isNotEmpty() }?.let { p.put("landmark", it.take(200)) }
        if (acknowledged.isNotEmpty()) p.put("acknowledgedDuplicateIds", JSONArray(acknowledged.distinct().take(10)))
        return p
    }
}
