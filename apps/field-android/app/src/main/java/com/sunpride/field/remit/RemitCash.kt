package com.sunpride.field.remit

import org.json.JSONObject
import java.math.BigDecimal
import java.security.MessageDigest
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import java.util.Base64
import java.util.UUID

/**
 * SP-0228 Remit cash: a salesman sends the cash he collected through a remittance center (Palawan,
 * Cebuana, GCash, a bank deposit or another) and records it here with the receipt photo. The record is
 * saved on the phone first and sent by itself through the usual sync (op `remittance.submit`), so it
 * works without signal. Finance confirms it on the web. No amount threshold (client, 20 Nov).
 */
object RemitCash {
    const val KIND = "remittance.submit"
    /** Server limit for the receipt JPEG (validateCollectionJpeg) and its longest side (≤ 1 MP). */
    const val MAX_PHOTO_BYTES = 64 * 1024
    const val MAX_SIDE = 1024
    private val ZONE: ZoneId = ZoneId.of("Asia/Manila")
    private val WHEN: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    /** Wire code to the label the salesman reads. Mirrors CHANNELS in apps/api/src/domains/remittances/model.js. */
    val CHANNELS: List<Pair<String, String>> = listOf(
        "palawan" to "Palawan Express",
        "cebuana" to "Cebuana Lhuillier",
        "gcash" to "GCash",
        "bank_deposit" to "Bank deposit",
        "other" to "Other",
    )

    const val SAVED = "Saved on this phone. It sends by itself when there is signal; Finance then checks the receipt."
    const val GUIDANCE = "Remit the cash the same day or the next day, then record it here with the receipt."

    /** "2026-11-17 14:05" for now in Manila (the form's starting value). */
    fun nowText(now: Long = System.currentTimeMillis()): String =
        LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(now), ZONE).format(WHEN)

    /** Pesos text → centavos. Any positive amount; no threshold. */
    fun minor(text: String): Long {
        val clean = text.trim().replace(",", "")
        require(clean.isNotEmpty()) { "Enter the amount you remitted" }
        val n = try { BigDecimal(clean).movePointRight(2).longValueExact() }
        catch (_: Exception) { throw IllegalArgumentException("Enter the amount in pesos, with at most two decimals (e.g. 50000 or 1250.50)") }
        require(n in 1..99_999_999_999L) { "Enter an amount more than ₱0" }
        return n
    }

    /** "YYYY-MM-DD HH:MM" in Manila → epoch ms; not in the future and within the last 30 days. */
    fun remittedAt(text: String, now: Long = System.currentTimeMillis()): Long {
        val at = try { LocalDateTime.parse(text.trim(), WHEN).atZone(ZONE).toInstant().toEpochMilli() }
        catch (_: DateTimeParseException) { throw IllegalArgumentException("Enter the date and time as YYYY-MM-DD HH:MM (e.g. 2026-11-17 14:05)") }
        require(at <= now + 10 * 60_000L) { "The remittance time cannot be in the future" }
        require(at >= now - 30L * 86_400_000L) { "Record remittances from the last 30 days only" }
        return at
    }

    /** The receipt JPEG as the op carries it. */
    fun photo(jpeg: ByteArray): JSONObject {
        require(jpeg.size in 4..MAX_PHOTO_BYTES && jpeg[0] == 0xff.toByte() && jpeg[1] == 0xd8.toByte()) {
            "Retake the receipt photo"
        }
        val digest = MessageDigest.getInstance("SHA-256").digest(jpeg).joinToString("") { "%02x".format(it) }
        return JSONObject().put("mimeType", "image/jpeg").put("bytesBase64", Base64.getEncoder().encodeToString(jpeg)).put("sha256", digest)
    }

    /**
     * Builds and checks the payload. [remittanceId] stays the same for one form so a second tap or a retry can
     * never create a second remittance (the server treats the same id as the same record).
     */
    fun payload(
        remittanceId: String, amount: String, channel: String?, channelOther: String, reference: String,
        remittedAtText: String, note: String, jpeg: ByteArray?, now: Long = System.currentTimeMillis(),
    ): JSONObject {
        UUID.fromString(remittanceId)
        val amountMinor = minor(amount)
        require(channel != null && CHANNELS.any { it.first == channel }) { "Choose where you remitted the cash" }
        val other = channelOther.trim()
        if (channel == "other") require(other.isNotEmpty()) { "Write the name of the remittance center" }
        require(other.length <= 80) { "Remittance center name is too long" }
        val ref = reference.trim()
        require(ref.isNotEmpty()) { "Enter the reference number from the receipt" }
        require(ref.length <= 80) { "Reference number is too long" }
        val at = remittedAt(remittedAtText, now)
        require(note.trim().length <= 500) { "Note is too long (up to 500 characters)" }
        val receipt = photo(jpeg ?: throw IllegalArgumentException("Take a photo of the receipt"))
        return JSONObject()
            .put("remittanceId", remittanceId)
            .put("amountMinor", amountMinor)
            .put("channel", channel)
            .apply { if (channel == "other") put("channelOther", other) }
            .put("referenceNumber", ref)
            .put("remittedAt", at)
            .apply { if (note.isNotBlank()) put("note", note.trim()) }
            .put("photo", receipt)
    }
}
