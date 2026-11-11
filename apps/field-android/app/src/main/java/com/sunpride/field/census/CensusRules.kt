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
    /** Field "Edit store": a change request for an existing store (same op, kind = change). */
    const val CHANGE = "change"
    fun isChange(p: JSONObject): Boolean = p.optString("kind") == CHANGE
    fun validate(p: JSONObject) {
        if (isChange(p)) return validateChange(p)
        // SP-0170 Add customer: the client's customer object instead of the old channel/class fields.
        if (p.has("customer")) return CustomerCapture.validate(p)
        // SP-0163: batchId is optional (server files it under the agent's ongoing batch); when sent it must be valid.
        val keys = listOf("captureId", "channelId", "subchannelId") + (if (p.has("batchId") && !p.isNull("batchId")) listOf("batchId") else emptyList())
        keys.forEach { require(uuid.matches(p.getString(it))) { "Choose a valid census batch and channel." } }
        for ((key, max) in listOf("name" to 200, "address" to 500, "ownerName" to 150, "ownerPhone" to 40))
            require(p.getString(key).trim().length in 1..max) { "Complete the customer and owner details." }
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
    /** A change carries the whole edited store; location and photo are optional (left out = unchanged). */
    fun validateChange(p: JSONObject) {
        require(uuid.matches(p.getString("captureId")) && uuid.matches(p.getString("targetOutletId"))) { "Open the customer again, then edit it." }
        for ((key, max) in listOf("name" to 200, "address" to 500, "ownerName" to 150, "ownerPhone" to 40))
            require(p.getString(key).trim().length in 1..max) { "Complete the customer and owner details." }
        require(p.getString("ownerPhone").count { it.isDigit() } >= 7) { "Enter a complete owner phone number." }
        require(p.optString("landmark").length <= 200) { "Keep the landmark under 200 characters." }
        require(!p.has("channelId") && !p.has("batchId")) { "A customer change cannot move the customer to another batch or channel." }
        val at = p.getLong("deviceTime")
        p.optJSONObject("location")?.let { l ->
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
        }
        p.optString("photoJpegBase64").takeIf { it.isNotEmpty() }?.let {
            val photo = Base64.getDecoder().decode(it)
            require(photo.size in 4..MAX_PHOTO_BYTES && photo[0] == 0xff.toByte() && photo[1] == 0xd8.toByte() &&
                photo[photo.size - 2] == 0xff.toByte() && photo.last() == 0xd9.toByte()) { "Take a storefront photo." }
        }
    }
    /** Required fields of Edit store: name, owner, phone and address. Location and photo stay as they are unless set. */
    fun missingForChange(name: String, owner: String, phone: String, mode: String, hasFix: Boolean, hasPlace: Boolean,
        address: String): List<Field> = buildList {
        if (name.isBlank()) add(Field.NAME)
        if (owner.isBlank()) add(Field.OWNER)
        if (phone.count { it.isDigit() } < 7) add(Field.PHONE)
        if ((mode == "gps" && !hasFix) || (mode == "places" && !hasPlace)) add(Field.LOCATION)
        if (address.isBlank()) add(Field.ADDRESS)
    }
    /** The store as it is on the phone, to compare with the edited form. */
    data class Current(val name: String, val address: String, val ownerName: String, val ownerPhone: String)
    /** True when the edited form differs from the store (a new location or photo always counts). */
    fun changed(current: Current, name: String, address: String, ownerName: String, ownerPhone: String, landmark: String,
        moved: Boolean, photo: Boolean): Boolean = moved || photo || landmark.isNotBlank() ||
        current.name.trim() != name.trim() || current.address.trim() != address.trim() ||
        current.ownerName.trim() != ownerName.trim() || current.ownerPhone.trim() != ownerPhone.trim()
    /** Edit store payload: same op as Add store, linked to the existing store by [targetOutletId]. */
    fun changePayload(captureId: String, targetOutletId: String, name: String, address: String, ownerName: String,
        ownerPhone: String, deviceTime: Long, gpsFix: JSONObject?, place: Place?, landmark: String, photo: String?): JSONObject {
        val p = JSONObject().put("kind", CHANGE).put("targetOutletId", targetOutletId).put("captureId", captureId)
            .put("name", name.trim()).put("address", address.trim()).put("ownerName", ownerName.trim())
            .put("ownerPhone", ownerPhone.trim()).put("deviceTime", deviceTime)
        if (place != null) {
            p.put("locationSource", "places").put("placeId", place.placeId)
                .put("location", JSONObject().put("latitude", place.latitude).put("longitude", place.longitude))
            place.formattedAddress?.let { p.put("formattedAddress", it.take(500)) }
            place.components?.takeIf { it.length() > 0 }?.let { p.put("addressComponents", it) }
        } else if (gpsFix != null) p.put("locationSource", "gps").put("location", gpsFix)
        landmark.trim().takeIf { it.isNotEmpty() }?.let { p.put("landmark", it.take(200)) }
        photo?.takeIf { it.isNotEmpty() }?.let { p.put("photoJpegBase64", it) }
        return p
    }
    /** Label per store with an Edit store change the office has not applied yet. Queued: "Change waiting for office · Saved on phone".
     * Sent: "Change waiting for office" while the store still differs from the proposal (an approved change arrives
     * with the next sync and clears it, as does an "accepted" decision). A rejected decision clears the waiting label and
     * says "Change not accepted: <reason>" once. Refused by the server: "Change needs a look". [history] is (payload,
     * outbox state, created at), oldest first; the newest change per store wins. */
    fun waitingChanges(history: List<Triple<JSONObject, String, Long>>, stores: Map<String, Current>, now: Long,
        decisions: Map<String, Decision> = emptyMap(), seen: Set<String> = emptySet()): Map<String, String> {
        val out = linkedMapOf<String, String>()
        history.filter { (p, _, _) -> isChange(p) }.sortedBy { it.third }.forEach { (p, state, at) ->
            val id = p.optString("targetOutletId"); val store = stores[id] ?: return@forEach
            val decision = decisions[p.optString("captureId")]
            // Name and address show that the office applied the change even before its decision is fetched.
            val differs = store.name.trim() != p.optString("name").trim() || store.address.trim() != p.optString("address").trim()
            val label = when {
                state == "review" -> CHANGE_REFUSED
                state != "done" -> CHANGE_ON_PHONE
                decision?.accepted == true -> null
                // Rejected: said once on the store page, then gone ([seen] holds the ones already shown).
                decision != null -> if (decision.captureId in seen) null else notAccepted(decision.reason)
                differs && now - at <= CHANGE_WAIT_MS -> CHANGE_WAITING
                else -> null
            }
            if (label == null) out.remove(id) else out[id] = label
        }
        return out
    }
    /** The office's decision on one of this person's sent changes (GET /api/v1/masters/census/my-changes). */
    data class Decision(val captureId: String, val targetOutletId: String, val accepted: Boolean, val reason: String?)
    fun notAccepted(reason: String?): String =
        reason?.trim()?.takeIf { it.isNotEmpty() }?.let { "$CHANGE_NOT_ACCEPTED: ${it.take(200)}" } ?: CHANGE_NOT_ACCEPTED
    /** Reads the decisions list; anything malformed is skipped, never guessed. */
    fun decisions(json: JSONObject?): Map<String, Decision> {
        val a = json?.optJSONArray("items") ?: return emptyMap()
        return (0 until a.length()).mapNotNull { i ->
            val o = a.optJSONObject(i) ?: return@mapNotNull null
            val capture = o.optString("captureId").takeIf { uuid.matches(it) } ?: return@mapNotNull null
            val target = o.optString("targetOutletId").takeIf { uuid.matches(it) } ?: return@mapNotNull null
            val accepted = when (o.optString("decision")) { "accepted" -> true; "rejected" -> false; else -> return@mapNotNull null }
            Decision(capture, target, accepted, if (o.isNull("reason")) null else o.optString("reason").takeIf { it.isNotBlank() })
        }.associateBy { it.captureId }
    }
    /** Rejections for [outletId] that the store page shows now (mark them seen so they show only once). */
    fun rejectionsToMark(history: List<Triple<JSONObject, String, Long>>, decisions: Map<String, Decision>, outletId: String,
        seen: Set<String>): Set<String> = history.filter { (p, state, _) -> isChange(p) && state == "done" &&
            p.optString("targetOutletId") == outletId }
        .mapNotNull { decisions[it.first.optString("captureId")] }.filter { !it.accepted && it.captureId !in seen }
        .map { it.captureId }.toSet()
    const val CHANGE_NOT_ACCEPTED = "Change not accepted"
    const val CHANGE_ON_PHONE = "Change waiting for office · Saved on phone"
    const val CHANGE_WAITING = "Change waiting for office"
    const val CHANGE_REFUSED = "Change needs a look"
    /** A sent change that never shows up (rejected) stops showing as waiting after two weeks. */
    const val CHANGE_WAIT_MS = 14L * 24 * 3600_000
    fun intent(scope: StoreScope, payload: JSONObject, now: Long): IntentRow {
        validate(payload)
        require(kotlin.math.abs(now - payload.getLong("deviceTime")) <= 120_000)
        val id = payload.getString("captureId")
        val operation = JSONObject().put("clientRequestId", id).put("kind", KIND)
            .put("dependsOn", JSONArray()).put("payload", JSONObject(payload.toString()))
        return IntentRow(scope.account, scope.deviceId, scope.fingerprint, id, id, KIND, operation.toString(), now)
    }
    fun captureId(): String = UUID.randomUUID().toString()

    /** Live-test fix: Save with missing fields must point at each one in plain words, in form order. */
    enum class Field(val message: String) {
        NAME("Type the customer name"), OWNER("Type the owner's name"), PHONE("Type the owner's phone number"),
        CHANNEL("Choose a channel"), SUBCHANNEL("Choose a sub-channel"), LOCATION("Tap Use my location or Search address"),
        ADDRESS("Type the address"), PHOTO("Take a storefront photo")
    }
    /** Every missing or incomplete required field, top of the form first. [mode] is "", "gps" or "places". */
    fun missing(name: String, owner: String, phone: String, channel: String, subchannel: String, mode: String,
        hasFix: Boolean, hasPlace: Boolean, address: String, hasPhoto: Boolean): List<Field> = buildList {
        if (name.isBlank()) add(Field.NAME)
        if (owner.isBlank()) add(Field.OWNER)
        if (phone.count { it.isDigit() } < 7) add(Field.PHONE)
        if (!uuid.matches(channel)) add(Field.CHANNEL)
        if (!uuid.matches(subchannel)) add(Field.SUBCHANNEL)
        if (mode == "" || (mode == "gps" && !hasFix) || (mode == "places" && !hasPlace)) add(Field.LOCATION)
        if (address.isBlank()) add(Field.ADDRESS)
        if (!hasPhoto) add(Field.PHOTO)
    }
    /** Short line next to Save. */
    fun missingSummary(count: Int): String = if (count == 1) "Fill in the field marked above" else "Fill in the $count fields marked above"

    const val MAX_FIX_AGE_MS = 120_000L
    /** Same freshness rule as [validate]: a GPS fix older than two minutes is refused. */
    fun fixIsStale(fix: JSONObject?, now: Long): Boolean = fix != null && kotlin.math.abs(now - fix.optLong("fixTime", 0L)) > MAX_FIX_AGE_MS
    /** Same accuracy rule as Use my location: strictly under 50 m and not a mock location. */
    fun fixUsable(fix: JSONObject?): Boolean {
        val a = fix?.optDouble("accuracyMeters", Double.NaN) ?: return false
        return !fix.optBoolean("mockSignal") && a > 0 && a < 50
    }
    const val MOVED_METERS = 50.0
    /** The refreshed point is far enough from the confirmed one that the agent must check the address again. */
    fun movedTooFar(old: JSONObject?, new: JSONObject): Boolean {
        val d = DuplicateRules.distanceMeters(old?.optDouble("latitude"), old?.optDouble("longitude"),
            new.optDouble("latitude"), new.optDouble("longitude")) ?: return false
        return d > MOVED_METERS
    }

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
