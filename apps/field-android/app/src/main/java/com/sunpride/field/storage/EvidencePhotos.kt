package com.sunpride.field.storage

import org.json.JSONObject
import java.security.MessageDigest

/** AND-016 bootstrap `photoTypes[]` entry: a code the server accepts on attach, and its label. */
data class PhotoType(val code: String, val label: String)

/** What the person sees for one captured photo; never the file, key or server IDs. */
data class VisitPhoto(val localId: String, val photoType: String, val capturedAt: Long, val sizeBytes: Long,
    val state: String, val reviewCode: String? = null)

/**
 * Visit photo evidence rules shared by the controller, both stores and the uploader.
 *
 * A photo is local first: the encrypted bytes and this metadata are durable before anything is
 * sent. Upload runs separately from the visit outbox, so a waiting photo never blocks Start,
 * activities or End, and End never waits for a network.
 */
object EvidencePhotos {
    const val MIME = "image/jpeg"
    /** Server `MAX_EVIDENCE_BYTES`. */
    const val MAX_BYTES = 10L * 1024 * 1024
    /** Photos per call kept on the phone; the server accepts up to 500 per visit. */
    const val MAX_PER_VISIT = 20
    /** A claim that expired mid-upload gets a fresh one; after this many tries the office reviews it. */
    const val MAX_ATTEMPTS = 5
    val STATES = setOf("pending", "uploaded", "review")

    /**
     * Used only when the server predates `photoTypes` (or sent none). Mirrors the backend's
     * provisional `EVIDENCE_PHOTO_TYPES`; the server still validates every code on attach.
     */
    val DEFAULT_TYPES = listOf(
        PhotoType("storefront", "Store front"),
        PhotoType("shelf_display", "Shelf and display"),
        PhotoType("price_tag", "Price tags"),
        PhotoType("promotion", "Promotion material"),
        PhotoType("other", "Other"),
    )

    private val CODE = Regex("^[a-z0-9_-]{1,40}$")

    fun decode(o: JSONObject): PhotoType {
        require(o.keys().asSequence().toSet() == setOf("code", "label"))
        val code = o.get("code") as? String ?: error("code")
        val label = o.get("label") as? String ?: error("label")
        require(CODE.matches(code) && label.isNotBlank() && label.length <= 80)
        return PhotoType(code, label.trim())
    }
    fun encode(type: PhotoType): JSONObject = JSONObject().put("code", type.code).put("label", type.label)

    /** The configured list, or the provisional defaults when none was downloaded. */
    fun offered(downloaded: List<PhotoType>): List<PhotoType> = downloaded.ifEmpty { DEFAULT_TYPES }
    fun label(code: String, types: List<PhotoType>): String =
        offered(types).firstOrNull { it.code == code }?.label ?: "Photo"

    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes)
        .joinToString("") { "%02x".format(it.toInt() and 0xff) }

    /** A JPEG starts with SOI (FF D8) and ends with EOI (FF D9). */
    fun isJpeg(bytes: ByteArray): Boolean = bytes.size >= 4 &&
        bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() &&
        bytes[bytes.size - 2] == 0xFF.toByte() && bytes[bytes.size - 1] == 0xD9.toByte()

    /**
     * A photo belongs to an open call: after a non-rejected Start, before End is queued. The
     * caller passes the device-wide history; the call is identified by its client visit ID.
     */
    fun requireOpenCall(clientVisitId: String, checkInRequestId: String,
        history: List<Pair<IntentRow, String>>) {
        val start = history.firstOrNull { it.first.requestId == checkInRequestId }
        if (start == null || start.first.kind != "visit.checkIn" || start.first.clientVisitId != clientVisitId ||
            start.second == "review")
            throw VisitRuleFailure(VisitRuleFailure.Code.CALL_NOT_OPEN)
        if (history.any { it.first.clientVisitId == clientVisitId && it.first.kind == "visit.checkOut" })
            throw VisitRuleFailure(VisitRuleFailure.Code.ALREADY_ENDED)
    }

    /** Store-side validation of a new photo row; both stores call it inside their write. */
    fun validate(row: EvidencePhotoRow, types: List<PhotoType>, history: List<Pair<IntentRow, String>>,
        existingForVisit: Int) {
        require(row.localId.isNotBlank() && row.clientVisitId.isNotBlank() && row.checkInRequestId.isNotBlank())
        require(row.state == "pending" && row.attempts == 0 && row.evidenceId == null && row.reviewCode == null)
        require(row.mime == MIME && row.sizeBytes in 1..MAX_BYTES && row.sha256.matches(Regex("^[0-9a-f]{64}$")))
        require(row.capturedAt > 0)
        require(offered(types).any { it.code == row.photoType }) { "Unknown photo type" }
        requireOpenCall(row.clientVisitId, row.checkInRequestId, history)
        if (existingForVisit >= MAX_PER_VISIT) throw VisitRuleFailure(VisitRuleFailure.Code.PHOTO_LIMIT)
    }

    fun view(row: EvidencePhotoRow) = VisitPhoto(row.localId, row.photoType, row.capturedAt, row.sizeBytes,
        row.state, row.reviewCode)

    fun stateLabel(photo: VisitPhoto): String = when (photo.state) {
        "uploaded" -> "Uploaded"
        "review" -> "Not uploaded · office will review"
        else -> "Saved on phone · uploads when online"
    }
    /** Short Done-card summary, e.g. "3 photos · 1 waiting to upload". */
    fun summary(photos: List<VisitPhoto>): String? {
        if (photos.isEmpty()) return null
        val waiting = photos.count { it.state == "pending" }
        val review = photos.count { it.state == "review" }
        return listOfNotNull("${photos.size} photo" + if (photos.size == 1) "" else "s",
            waiting.takeIf { it > 0 }?.let { "$it waiting to upload" },
            review.takeIf { it > 0 }?.let { "$it for office review" }).joinToString(" · ")
    }
}
