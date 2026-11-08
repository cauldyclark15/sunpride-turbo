package com.sunpride.field.census

import java.text.Normalizer
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.roundToLong
import kotlin.math.sin
import kotlin.math.sqrt

/** SP-0163 shared store-duplicate rules: a line-by-line port of
 * packages/domain-contracts/fixtures/mobile-v1/census-duplicates.json (server and iOS implement the same file). */
object DuplicateRules {
    val STOPWORDS = setOf("and", "co", "corp", "enterprise", "enterprises", "general", "groceries", "grocery", "inc",
        "mart", "merchandise", "mini", "minimart", "ng", "sari", "sarisari", "shop", "store", "stores", "the", "trading")
    const val NEARBY_METERS = 75.0
    const val VERY_NEAR_METERS = 25.0
    const val NAME_SIMILARITY = 0.8
    const val NAME_MAX_METERS = 2000.0
    const val MAX_RESULTS = 10
    private const val EARTH_RADIUS = 6371008.8
    private val marks = Regex("\\p{M}+")
    private val nonWord = Regex("[^a-z0-9]+")

    data class Store(val id: String, val name: String, val phone: String? = null, val latitude: Double? = null,
        val longitude: Double? = null, val placeId: String? = null, val kind: String = "outlet", val address: String? = null)

    data class Candidate(val kind: String, val id: String, val name: String, val address: String?,
        val latitude: Double?, val longitude: Double?, val distanceMeters: Double?, val reasons: List<String>, val score: Int)

    fun nameTokens(name: String): Set<String> {
        val folded = marks.replace(Normalizer.normalize(name, Normalizer.Form.NFKD), "").lowercase()
        val words = nonWord.replace(folded, " ").trim().split(' ').filter { it.isNotEmpty() }
        val kept = words.filter { it !in STOPWORDS }
        return (kept.ifEmpty { words }).toSortedSet()
    }

    fun nameSimilarity(a: String, b: String): Double {
        val x = nameTokens(a); val y = nameTokens(b)
        if (x.isEmpty() || y.isEmpty()) return 0.0
        val ratio = (x intersect y).size.toDouble() / (x union y).size
        return (ratio * 10_000).roundToLong() / 10_000.0
    }

    fun phoneKey(phone: String?): String? {
        var digits = phone?.filter { it in '0'..'9' } ?: return null
        if (digits.length == 12 && digits.startsWith("63")) digits = "0" + digits.takeLast(10)
        return if (digits.length < 10) null else digits.takeLast(10)
    }

    fun distanceMeters(lat1: Double?, lng1: Double?, lat2: Double?, lng2: Double?): Double? {
        if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null
        val p1 = Math.toRadians(lat1); val p2 = Math.toRadians(lat2)
        val dp = p2 - p1; val dl = Math.toRadians(lng2 - lng1)
        val h = sin(dp / 2) * sin(dp / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        val d = 2 * EARTH_RADIUS * asin(sqrt(h.coerceIn(0.0, 1.0)))
        return (d * 10).roundToLong() / 10.0
    }

    /** null when [existing] is not a candidate for [query]. */
    fun evaluate(query: Store, existing: Store): Candidate? {
        val distance = distanceMeters(query.latitude, query.longitude, existing.latitude, existing.longitude)
        val similarity = nameSimilarity(query.name, existing.name)
        val reasons = mutableListOf<String>()
        if (!query.placeId.isNullOrEmpty() && query.placeId == existing.placeId) reasons += "place"
        val key = phoneKey(query.phone)
        if (key != null && key == phoneKey(existing.phone)) reasons += "phone"
        if (distance != null && distance <= NEARBY_METERS) reasons += "nearby"
        if (similarity >= NAME_SIMILARITY && (distance == null || distance <= NAME_MAX_METERS)) reasons += "name"
        if (reasons.isEmpty()) return null
        var score = 0
        if ("place" in reasons) score += 100
        if ("phone" in reasons) score += 90
        if ("nearby" in reasons) score += if (distance!! <= VERY_NEAR_METERS) 80 else 60
        if ("name" in reasons) score += Math.round(30 * similarity).toInt()
        return Candidate(existing.kind, existing.id, existing.name, existing.address, existing.latitude, existing.longitude,
            distance, reasons, score)
    }

    val order: Comparator<Candidate> = compareByDescending<Candidate> { it.score }
        .thenBy { it.distanceMeters ?: Double.MAX_VALUE }.thenBy { it.name }

    fun find(query: Store, stores: List<Store>): List<Candidate> =
        stores.mapNotNull { evaluate(query, it) }.sortedWith(order).take(MAX_RESULTS)

    /** Phone (offline) and server candidates; the server's copy of a shared id wins (it knows phones and place ids). */
    fun merge(local: List<Candidate>, server: List<Candidate>): List<Candidate> {
        val byId = LinkedHashMap<String, Candidate>()
        local.forEach { byId[it.id] = it }
        server.forEach { byId[it.id] = it }
        return byId.values.sortedWith(order).take(MAX_RESULTS)
    }

    /** Plain words for the agent, strongest reason first. */
    fun reasonText(reasons: List<String>): String = reasons.mapNotNull {
        when (it) {
            "place" -> "Same place on Google"; "phone" -> "Same phone number"
            "nearby" -> "Very close by"; "name" -> "Same name nearby"; else -> null
        }
    }.joinToString(" · ")

    fun distanceText(meters: Double?): String? = when {
        meters == null -> null
        meters < 1000 -> "${meters.roundToLong()} m away"
        else -> "${"%.1f".format(java.util.Locale.US, meters / 1000)} km away"
    }
}
