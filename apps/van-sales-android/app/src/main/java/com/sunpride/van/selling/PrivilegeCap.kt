package com.sunpride.van.selling

import org.json.JSONObject
import java.security.MessageDigest
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.TemporalAdjusters

/**
 * IP-SCPWD-CAP: the weekly purchase limit on the senior citizen / PWD discount, as the phone knows it.
 *
 * The server is the authority (it adds up every store and van by ID number). The phone gets, with its bundle, the limit and what each
 * card used so far this week (`storePos.privilegeCap`, opt-in via `params.privilegeCap`; the card number is only ever a hash), and adds
 * the sales it made itself that the bundle cannot know yet. What is left is the BEST KNOWN: offline, another store or van may have sold
 * to the same card meanwhile. The sale is still printed and accepted; the server flags any overage in the office's Decide inbox.
 *
 * Week = Monday to Sunday, Manila time. Everything is integer centavos. Hash and key rules mirror
 * `apps/api/src/domains/fiscal/privilege-cap.js` (`idKey`, `idHash`, `manilaWeekStart`).
 */
data class PrivilegeCapInfo(
    val enabled: Boolean, val capMinor: Long, val confirmed: Boolean, val weekStart: String, val weekEndsAt: Long,
    val asOf: Long, val complete: Boolean, val used: Map<String, Long>,
) {
    companion object {
        /** Null (no limit known) for a missing or unreadable block: an older server, or a bundle cached before this existed. */
        fun decode(o: JSONObject?): PrivilegeCapInfo? {
            if (o == null || o.optInt("version") != 1) return null
            return runCatching {
                val rows = o.optJSONArray("used")
                val used = HashMap<String, Long>()
                if (rows != null) for (i in 0 until rows.length()) {
                    val r = rows.getJSONObject(i)
                    val k = r.getString("k"); val v = r.getString("v").toLong()
                    require(Regex("^[0-9a-f]{32}$").matches(k) && v >= 0)
                    used[k] = v
                }
                val cap = o.getString("capCentavos").toLong()
                require(cap > 0)
                PrivilegeCapInfo(o.getBoolean("enabled"), cap, o.optBoolean("confirmed"), o.getString("weekStart"), o.getLong("weekEndsAt"),
                    o.getLong("asOf"), o.optBoolean("complete", true), used)
            }.getOrNull()
        }
    }
}

object PrivilegeCap {
    private val MANILA: ZoneId = ZoneId.of("Asia/Manila")

    /** Only the 5% basic-necessities discount has a weekly limit. */
    fun applies(type: PrivilegeType) = type == PrivilegeType.SENIOR || type == PrivilegeType.PWD

    /** Manila date (YYYY-MM-DD) of the Monday that starts the week of this instant. */
    fun weekStart(ms: Long): String = Instant.ofEpochMilli(ms).atZone(MANILA).toLocalDate().with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY)).toString()

    /** First instant of the week of [ms] (Monday 00:00 Manila). */
    fun weekStartMs(ms: Long): Long = java.time.LocalDate.parse(weekStart(ms)).atStartOfDay(MANILA).toInstant().toEpochMilli()

    /** `senior:SC2026004411`: the type plus the card number with everything but letters and digits removed, upper case. */
    fun idKey(type: PrivilegeType, idNumber: String): String = type.wire + ":" + idNumber.uppercase().filter { it in 'A'..'Z' || it in '0'..'9' }

    fun idHash(key: String): String = MessageDigest.getInstance("SHA-256").digest("sunpride-privcap-v1|$key".toByteArray())
        .joinToString("") { "%02x".format(it.toInt() and 255) }.take(32)

    /**
     * What is left of this card's week, best known on this phone; null = no limit applies (no bundle info, switched off, or a
     * type that has no limit), and then the sale is made with no limit and says so by sending no `capBasis`.
     * [localUsed] = centavos this phone has sold to the card that the bundle cannot include yet (key = [idKey]).
     */
    fun remaining(info: PrivilegeCapInfo?, claim: DiscountClaim, localUsed: Map<String, Long>, now: Long): Long? {
        if (info == null || !info.enabled || !applies(claim.type)) return null
        val key = idKey(claim.type, claim.idNumber)
        // A bundle from last week says nothing about this week.
        val fromBundle = if (weekStart(now) == info.weekStart) info.used[idHash(key)] ?: 0L else 0L
        return maxOf(0L, info.capMinor - fromBundle - (localUsed[key] ?: 0L))
    }

    /** The lookup the checkout uses; null when this phone knows of no limit. */
    fun remainingFn(info: PrivilegeCapInfo?, localUsed: Map<String, Long>, now: Long): ((DiscountClaim) -> Long?)? =
        if (info == null) null else { claim -> remaining(info, claim, localUsed, now) }

    /**
     * Discounted purchase this phone made itself this week per card ([idKey]) that the bundle does not include: sales still waiting
     * to be sent, and sales sent after the bundle was made. Rejected and voided sales do not count. Read from the frozen
     * `discountClaim.capBasis.appliedCentavos` of each sale (a sale made before this feature has none and counts nothing).
     * [claims] = one `(status, deviceTime, discountClaim)` per sale on this phone.
     */
    fun localUsed(info: PrivilegeCapInfo?, now: Long, claims: List<Triple<String, Long, JSONObject>>): Map<String, Long> {
        if (info == null) return emptyMap()
        val weekFrom = weekStartMs(now)
        val out = HashMap<String, Long>()
        for ((status, at, claim) in claims) {
            if (status == "rejected" || status == "conflict" || at < weekFrom) continue
            if (status == "done" && at <= info.asOf) continue // already in the bundle
            val type = PrivilegeType.of(claim.optString("type")) ?: continue
            if (!applies(type)) continue
            val applied = claim.optJSONObject("capBasis")?.optString("appliedCentavos")?.toLongOrNull() ?: continue
            if (applied <= 0) continue
            val key = idKey(type, claim.optString("idNumber"))
            out[key] = Math.addExact(out[key] ?: 0L, applied)
        }
        return out
    }

    /** "Weekly limit: ₱300.00 left", the same words as the server's receipt. */
    fun leftText(leftMinor: Long): String = "Weekly limit: ${Peso.format(leftMinor)} left"
}
