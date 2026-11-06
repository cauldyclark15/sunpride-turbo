package com.sunpride.van.ui

import com.sunpride.van.data.HandheldInfo
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * IP-P0 (SPEC 5.3): the "No trip" and "No load sheet" screens name the van, the supervisor and the last sync.
 * A part the office has not sent is left out of the sentence, never guessed.
 */
object NoTripMessage {
    fun lastSynced(at: Long?, now: Long, zone: ZoneId): String {
        if (at == null) return "Not synced yet."
        val t = Instant.ofEpochMilli(at).atZone(zone)
        val sameDay = t.toLocalDate() == Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        return "Last synced " + t.format(DateTimeFormatter.ofPattern(if (sameDay) "HH:mm" else "MMM d, HH:mm")) + "."
    }
    fun sentence(what: String, info: HandheldInfo?, lastSyncAt: Long?, now: Long, zone: ZoneId): String {
        val head = info?.vanLabel?.let { "$what for today on van $it." } ?: "$what for today."
        val name = info?.supervisorName; val phone = info?.supervisorPhone
        val boss = when {
            name != null && phone != null -> "Your supervisor is $name ($phone)."
            name != null -> "Your supervisor is $name."
            phone != null -> "Your supervisor's number is $phone."
            else -> "Ask your supervisor."
        }
        return "$head $boss ${lastSynced(lastSyncAt,now,zone)}"
    }
    /** `tel:` target for the dialer (ACTION_DIAL, never a silent call); null when there is no usable number. */
    fun dialUri(phone: String?): String? {
        val digits = phone?.filter { it.isDigit() || it == '+' }?.takeIf { p -> p.count { it.isDigit() } in 5..15 && p.indexOf('+', 1) < 0 } ?: return null
        return "tel:$digits"
    }
}
