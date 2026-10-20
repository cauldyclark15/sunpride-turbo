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
    private val uuid = Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
    fun validate(p: JSONObject) {
        listOf("captureId", "batchId", "channelId", "subchannelId").forEach { require(uuid.matches(p.getString(it))) { "Choose a valid census batch and channel." } }
        for ((key, max) in listOf("name" to 200, "address" to 500, "ownerName" to 150, "ownerPhone" to 40))
            require(p.getString(key).trim().length in 1..max) { "Complete the store and owner details." }
        require(p.getString("ownerPhone").count { it.isDigit() } >= 7) { "Enter a complete owner phone number." }
        require(p.getString("estimatedClass") in listOf("A", "B", "C", "D"))
        val at = p.getLong("deviceTime")
        val l = p.getJSONObject("location")
        require(l.getDouble("latitude").isFinite() && l.getDouble("latitude") in -90.0..90.0)
        require(l.getDouble("longitude").isFinite() && l.getDouble("longitude") in -180.0..180.0)
        require(l.getDouble("accuracyMeters") > 0 && l.getDouble("accuracyMeters") < 50 && !l.getBoolean("mockSignal") &&
            l.getString("provider") in listOf("gps", "fused", "network") && kotlin.math.abs(at - l.getLong("fixTime")) <= 120_000) {
            "Get a fresh GPS fix with accuracy under 50 m. Mock locations cannot be used."
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
}
