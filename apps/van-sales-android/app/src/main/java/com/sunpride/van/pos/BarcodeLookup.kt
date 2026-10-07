package com.sunpride.van.pos

import com.sunpride.van.data.Product
import java.util.Locale

/** How a scanned code reached a product; earlier entries are stronger evidence. */
enum class ScanMatch { BARCODE, GTIN, GS1, PRODUCT_CODE }

/**
 * The unit one scan stands for. [uomCode] null means the cached product data predates
 * per-barcode units, so the unit is not confirmed; [baseQuantity] null means no exact
 * conversion to the van's selling unit exists. Either way no quantity may be guessed.
 */
data class ScanUnit(val uomCode: String?, val baseQuantity: Long?) {
    val quantityKnown: Boolean get() = uomCode != null && baseQuantity != null
}

data class ScanCandidate(val product: Product, val unit: ScanUnit, val match: ScanMatch, val barcode: String) {
    val isSellingUnit: Boolean get() = unit.uomCode == product.uomCode && unit.baseQuantity == product.quantityScale

    /** "CS · 24 PC" for a case barcode, "PC" for the selling unit, or why the quantity is unknown. */
    fun unitLabel(): String = when {
        unit.uomCode == null -> "Unit not confirmed by the office"
        isSellingUnit -> unit.uomCode
        unit.baseQuantity == null -> "${unit.uomCode} · no conversion to ${product.uomCode}"
        else -> "${unit.uomCode} · ${product.displayQuantity(unit.baseQuantity)} ${product.uomCode}"
    }
}

/**
 * VAN-009 offline barcode resolution, shared by the POS search and the load check.
 *
 * Order (the first level with any result wins, so weaker evidence never mixes with stronger):
 * 1. the exact barcode (also after removing a scanner's AIM symbology prefix such as `]E0`);
 * 2. the same GTIN in another length (UPC-A 12 vs EAN-13 13 vs GTIN-14, compared zero-padded);
 * 3. a GS1 element string carrying AI (01) with a valid check digit (GS1-128 / GS1 QR / DataMatrix);
 * 4. an exact product code (a QR or label that carries the Sunpride code).
 * Several products for one code is a data problem: every candidate is returned, never a guess.
 */
class BarcodeLookup(private val products: List<Product>) {
    fun resolve(scanned: String): List<ScanCandidate> {
        val raw = scanned.trimEnd('\r', '\n')
        if (raw.isEmpty()) return emptyList()
        val code = BarcodeKeys.stripAim(raw)
        exact(code).takeIf { it.isNotEmpty() }?.let { return it }
        BarcodeKeys.gtin14(code)?.let { key -> byKey(key, ScanMatch.GTIN).takeIf { it.isNotEmpty() }?.let { return it } }
        BarcodeKeys.gs1Gtin(code)?.let { key -> byKey(key, ScanMatch.GS1).takeIf { it.isNotEmpty() }?.let { return it } }
        val wanted = code.trim().lowercase(Locale.ROOT)
        return products.filter { it.code.lowercase(Locale.ROOT) == wanted && wanted.isNotEmpty() }
            .map { ScanCandidate(it, ScanUnit(it.uomCode, it.quantityScale), ScanMatch.PRODUCT_CODE, it.code) }
    }

    private fun exact(code: String) = candidates(ScanMatch.BARCODE) { it == code }
    private fun byKey(key: String, match: ScanMatch) = candidates(match) { BarcodeKeys.gtin14(it) == key }

    private fun candidates(match: ScanMatch, test: (String) -> Boolean): List<ScanCandidate> =
        products.flatMap { product ->
            product.barcodes.filter(test).map { barcode -> ScanCandidate(product, unitOf(product, barcode), match, barcode) }
        }.distinctBy { it.product.productId to it.unit }

    private fun unitOf(product: Product, barcode: String): ScanUnit {
        val unit = product.barcodeUnits.firstOrNull { it.barcode == barcode } ?: return ScanUnit(null, null)
        return ScanUnit(unit.uomCode, unit.baseQuantity)
    }
}

object BarcodeKeys {
    private val aim = Regex("^\\][A-Za-z][0-9A-Za-z]")
    private val gs1 = Regex("^(?:\\(01\\)|01)([0-9]{14})")

    /** Removes an AIM symbology identifier (`]E0`, `]C1`, `]Q3` …) some scanners prepend. */
    fun stripAim(code: String): String = if (code.length > 3 && aim.containsMatchIn(code)) code.substring(3) else code

    /** A numeric GTIN-8/12/13/14 zero-padded to 14 digits, or null for anything else. */
    fun gtin14(code: String): String? =
        if (code.length in GTIN_LENGTHS && code.all { it in '0'..'9' }) code.padStart(14, '0') else null

    /** The GTIN of a GS1 element string that starts with AI (01), only when its check digit is valid. */
    fun gs1Gtin(code: String): String? = gs1.find(code)?.groupValues?.get(1)?.takeIf(::checkDigitValid)

    fun checkDigitValid(gtin: String): Boolean {
        if (gtin.length !in GTIN_LENGTHS || !gtin.all { it in '0'..'9' }) return false
        val digits = gtin.map { it - '0' }
        val sum = digits.dropLast(1).reversed().mapIndexed { i, d -> if (i % 2 == 0) d * 3 else d }.sum()
        return (10 - sum % 10) % 10 == digits.last()
    }

    private val GTIN_LENGTHS = setOf(8, 12, 13, 14)
}
