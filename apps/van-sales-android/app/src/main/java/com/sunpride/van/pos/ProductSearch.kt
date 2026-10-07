package com.sunpride.van.pos

import com.sunpride.van.data.PriceLine
import com.sunpride.van.data.Product
import com.sunpride.van.data.TruckStock
import java.math.BigDecimal
import java.text.Normalizer
import java.util.Currency
import java.util.Locale

/** A scan resolved to one product row and the unit the barcode stands for (VAN-009). */
data class ScanHit(val hit: PosProductHit, val candidate: ScanCandidate)

/** How a product matched; lower ordinal ranks first. */
enum class MatchKind { BARCODE, CODE, CODE_PREFIX, BARCODE_PREFIX, NAME_PREFIX, WORD_PREFIX, CONTAINS, ALL }

/** A configured selling price for the product's own UOM, in minor currency units. */
data class PosPrice(val unitPriceMinor: Long, val currency: String, val uomCode: String) {
    fun label(): String = PosMoney.format(unitPriceMinor, currency) + " / " + uomCode
}

/** One row of the POS product list. [price] null means "Priced by the office" (no single configured price). */
data class PosProductHit(val product: Product, val availableBase: Long, val price: PosPrice?, val match: MatchKind) {
    val onTruck: Boolean get() = availableBase > 0
    fun availableLabel(): String = "${product.displayQuantity(availableBase)} ${product.uomCode}"
}

object PosMoney {
    fun format(minor: Long, currency: String): String {
        val digits = runCatching { Currency.getInstance(currency).defaultFractionDigits }.getOrNull()?.takeIf { it >= 0 } ?: 2
        val amount = BigDecimal.valueOf(minor).movePointLeft(digits).setScale(digits)
        val number = String.format(Locale.US, "%,.${digits}f", amount)
        return if (currency == "PHP") "₱$number" else "$currency $number"
    }
}

/**
 * Picks the configured price for a product at [now]: only lines for the product's own UOM that are
 * effective now. If no line, or several lines disagree (e.g. two price lists with different prices and
 * no rule yet for which applies), there is no single configured price and the UI says
 * "Priced by the office". A price is never derived from stock or product master data.
 */
object PriceResolver {
    /** The effective lines for the product's own UOM at [now] (VAN-011 records their list IDs as the price source). */
    fun matching(product: Product, lines: List<PriceLine>, now: Long): List<PriceLine> = lines.filter {
        it.productId == product.productId && it.uomCode == product.uomCode && it.unitPriceMinor >= 0 &&
            it.effectiveFrom <= now && (it.effectiveTo == null || now < it.effectiveTo)
    }
    fun resolve(product: Product, lines: List<PriceLine>, now: Long): PosPrice? {
        val distinct = matching(product, lines, now).map { it.unitPriceMinor to it.currency }.distinct()
        return distinct.singleOrNull()?.let { (minor, currency) -> PosPrice(minor, currency, product.uomCode) }
    }
}

/**
 * Offline product search for the POS screen. Built once per product/stock/price snapshot; [search] then
 * only scans precomputed lowercase keys, so it is cheap enough to run on every keystroke on the handheld.
 *
 * Matching: an exact barcode or product code wins; then code/barcode prefixes (the code also matches with
 * its punctuation removed, so "sppj1l" finds SP-PJ-1L); then names starting with the query; then every typed
 * word starting a word of the name/code; then every word contained anywhere. Within a rank, products with
 * stock on the truck come first, then by name.
 */
class ProductSearch(products: List<Product>, stock: List<TruckStock>, prices: List<PriceLine>, now: Long) {
    private class Entry(val hit: PosProductHit, val code: String, val compactCode: String, val name: String,
        val words: List<String>, val barcodes: List<String>, val haystack: String) {
        val gtins: Set<String> = barcodes.mapNotNull(BarcodeKeys::gtin14).toSet()
    }

    private val entries: List<Entry> = products.map { product ->
        val available = stock.firstOrNull { it.productId == product.productId }?.availableBase ?: 0L
        val code = normalize(product.code); val name = normalize(product.name)
        Entry(PosProductHit(product, available, PriceResolver.resolve(product, prices, now), MatchKind.ALL),
            code, compact(code), name, words(name) + words(code), product.barcodes, "$code $name")
    }
    private val order = compareBy<Pair<Entry, MatchKind>>({ it.second.ordinal }, { !it.first.hit.onTruck }, { it.first.name }, { it.first.code })

    private val lookup = BarcodeLookup(products)
    private val hitsById = entries.associate { it.hit.product.productId to it.hit }

    /**
     * VAN-009: resolve a hardware or camera scan to product(s) and the unit scanned (see [BarcodeLookup]).
     * Empty = not found; more than one = the same code is on several products (shown, never guessed).
     */
    fun resolveScan(code: String): List<ScanHit> = lookup.resolve(code).mapNotNull { candidate ->
        hitsById[candidate.product.productId]?.let { ScanHit(it.copy(match = MatchKind.BARCODE), candidate) }
    }

    /** The single product a scan resolves to, or null when it is unknown or ambiguous. */
    fun byBarcode(code: String): PosProductHit? = resolveScan(code).singleOrNull()?.hit

    fun search(query: String, limit: Int = 60): List<PosProductHit> {
        val q = normalize(query)
        val ranked = if (q.isEmpty()) entries.map { it to MatchKind.ALL }
        else {
            val tokens = words(q); val compactQ = compact(q); val raw = query.trim()
            entries.mapNotNull { e -> rank(e, q, compactQ, tokens, raw)?.let { e to it } }
        }
        return ranked.sortedWith(order).take(limit).map { (e, kind) -> e.hit.copy(match = kind) }
    }

    private fun rank(e: Entry, q: String, compactQ: String, tokens: List<String>, raw: String): MatchKind? = when {
        e.barcodes.any { it == raw } || BarcodeKeys.gtin14(raw)?.let { it in e.gtins } == true -> MatchKind.BARCODE
        e.code == q || (compactQ.isNotEmpty() && e.compactCode == compactQ) -> MatchKind.CODE
        e.code.startsWith(q) || (compactQ.isNotEmpty() && e.compactCode.startsWith(compactQ)) -> MatchKind.CODE_PREFIX
        raw.length >= 4 && e.barcodes.any { it.startsWith(raw) } -> MatchKind.BARCODE_PREFIX
        e.name.startsWith(q) -> MatchKind.NAME_PREFIX
        tokens.isNotEmpty() && tokens.all { t -> e.words.any { it.startsWith(t) } } -> MatchKind.WORD_PREFIX
        tokens.isNotEmpty() && tokens.all { e.haystack.contains(it) } -> MatchKind.CONTAINS
        else -> null
    }

    companion object {
        private val marks = Regex("\\p{M}+")
        private val separators = Regex("[^\\p{L}\\p{N}]+")
        internal fun normalize(text: String): String =
            marks.replace(Normalizer.normalize(text, Normalizer.Form.NFD), "").lowercase(Locale.ROOT).trim().replace(Regex("\\s+"), " ")
        internal fun words(text: String): List<String> = text.split(separators).filter { it.isNotEmpty() }
        internal fun compact(text: String): String = separators.replace(text, "")
    }
}
