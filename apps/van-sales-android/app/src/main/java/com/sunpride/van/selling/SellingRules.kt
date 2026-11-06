package com.sunpride.van.selling

import com.sunpride.van.data.Product
import com.sunpride.van.pos.BarcodeLookup
import com.sunpride.van.pos.CartLine
import com.sunpride.van.pos.ScanMatch
import java.math.BigDecimal

/** Where the sale happens; only the words of the refusal differ. */
enum class SellingPlace(val noun: String) { VAN("van"), STORE("store") }

/** What one scan means to a cart. Never a dialog: either a unit is added or the seller is told why not. */
sealed interface ScanAction {
    /** [baseQuantity] is the quantity of ONE scan: one piece for a piece barcode, one case for a case barcode. */
    data class Add(val product: Product, val baseQuantity: Long, val isCase: Boolean, val unitLabel: String) : ScanAction
    data class Refuse(val message: String) : ScanAction
}

/**
 * IP-HH1: the one scan rule for van and store (R4 section 4). A piece barcode adds 1 piece, a case barcode adds 1 case,
 * a product code adds 1 piece, and an unknown code is refused with a plain message. A case with no known size is
 * refused rather than guessed.
 */
object ScanRules {
    fun notInPlace(code: String, place: SellingPlace) = "Not in this ${place.noun}: $code"

    fun resolve(code: String, products: List<Product>, place: SellingPlace): ScanAction = resolve(code, BarcodeLookup(products), place)

    fun resolve(code: String, lookup: BarcodeLookup, place: SellingPlace): ScanAction {
        val candidates = lookup.resolve(code)
        if (candidates.isEmpty()) return ScanAction.Refuse(notInPlace(code.trimEnd('\r', '\n'), place))
        val byProduct = candidates.groupBy { it.product.productId }
        if (byProduct.size > 1) return ScanAction.Refuse("Barcode ${code.trimEnd('\r', '\n')} is on ${byProduct.size} products. Search by name and tell the office.")
        val units = candidates.map { it.unit }.distinct()
        val first = candidates.first()
        val product = first.product
        if (units.size > 1) return ScanAction.Refuse("${product.name}: barcode has more than one unit. Search by name.")
        // A barcode with no unit recorded (older cache) or a product code stands for the selling unit: one piece.
        if (first.match == ScanMatch.PRODUCT_CODE || first.unit.uomCode == null)
            return ScanAction.Add(product, product.quantityScale, false, product.uomCode)
        val quantity = first.unit.baseQuantity
            ?: return ScanAction.Refuse("${product.name}: case size not set. Search the product and enter pieces.")
        val isCase = !first.isSellingUnit
        return ScanAction.Add(product, quantity, isCase, first.unit.uomCode)
    }
}

sealed interface AddOutcome {
    data class Added(val lines: List<CartLine>, val newBase: Long) : AddOutcome
    data class OutOfStock(val name: String) : AddOutcome
    data class OnlyLeft(val name: String, val leftLabel: String) : AddOutcome
    data object TooMany : AddOutcome
}

/** Cart arithmetic shared by the grid, the palette, the scanner and the steppers. */
object SellingCart {
    const val MAX_BASE = 999_999_999_999_999_999L

    fun baseOf(lines: List<CartLine>, productId: String): Long = lines.firstOrNull { it.productId == productId }?.quantityBase ?: 0L

    /** Adds [amountBase] of [product]. Zero stock is blocked; more than what is left is refused with the number left. */
    fun add(lines: List<CartLine>, product: Product, amountBase: Long, availableBase: Long): AddOutcome {
        if (amountBase <= 0) return AddOutcome.TooMany
        if (availableBase <= 0) return AddOutcome.OutOfStock(product.name)
        val current = baseOf(lines, product.productId)
        val next = current + amountBase
        if (next > availableBase) return AddOutcome.OnlyLeft(product.name, "${product.displayQuantity(availableBase - current)} ${product.uomCode}")
        if (next > MAX_BASE || (current == 0L && lines.size >= com.sunpride.van.pos.CheckoutRules.MAX_LINES)) return AddOutcome.TooMany
        return AddOutcome.Added(set(lines, product.productId, next), next)
    }

    /** Sets a typed quantity (the keypad). Zero removes the line; above the stock on hand is refused. */
    fun setQuantity(lines: List<CartLine>, product: Product, base: Long, availableBase: Long): AddOutcome {
        if (base <= 0) return AddOutcome.Added(remove(lines, product.productId), 0)
        if (availableBase <= 0) return AddOutcome.OutOfStock(product.name)
        if (base > availableBase) return AddOutcome.OnlyLeft(product.name, "${product.displayQuantity(availableBase)} ${product.uomCode}")
        return AddOutcome.Added(set(lines, product.productId, base), base)
    }

    fun set(lines: List<CartLine>, productId: String, base: Long): List<CartLine> = when {
        base <= 0 -> remove(lines, productId)
        lines.any { it.productId == productId } -> lines.map { if (it.productId == productId) it.copy(quantityBase = base) else it }
        else -> lines + CartLine(productId, base)
    }
    fun remove(lines: List<CartLine>, productId: String): List<CartLine> = lines.filterNot { it.productId == productId }

    /** Plain words for a refusal (shown as the toast). */
    fun refusalText(outcome: AddOutcome): String? = when (outcome) {
        is AddOutcome.Added -> null
        is AddOutcome.OutOfStock -> "${outcome.name} is out of stock."
        is AddOutcome.OnlyLeft -> "Only ${outcome.leftLabel} left of ${outcome.name}."
        AddOutcome.TooMany -> "The cart cannot hold more of this."
    }
}

/** A case size taken from the product's own barcode units (never guessed). */
data class CasePack(val uomCode: String, val perCaseBase: Long)

object Quantities {
    fun casePack(product: Product): CasePack? = product.barcodeUnits
        .filter { val q = it.baseQuantity; q != null && q > product.quantityScale && q % product.quantityScale == 0L && it.uomCode != product.uomCode }
        .maxByOrNull { it.baseQuantity!! }?.let { CasePack(it.uomCode, it.baseQuantity!!) }

    /** Whole cases and the piece remainder in base units. */
    fun split(product: Product, base: Long): Pair<Long, Long> {
        val pack = casePack(product) ?: return 0L to base
        return base / pack.perCaseBase to base % pack.perCaseBase
    }

    /** "2 CS + 3 PC" when the product has a case size, else "5 PC". */
    fun label(product: Product, base: Long): String {
        val pack = casePack(product)
        if (pack == null) return "${product.displayQuantity(base)} ${product.uomCode}"
        val (cases, rest) = split(product, base)
        return when {
            cases == 0L -> "${product.displayQuantity(rest)} ${product.uomCode}"
            rest == 0L -> "$cases ${pack.uomCode}"
            else -> "$cases ${pack.uomCode} + ${product.displayQuantity(rest)} ${product.uomCode}"
        }
    }

    /** Category for the chips: the office's category when the bootstrap carries one, else the first word of the name. */
    fun category(product: Product): String = product.category?.trim()?.takeIf { it.isNotEmpty() }
        ?: product.name.trim().substringBefore(' ').trim().ifEmpty { "Other" }.lowercase().replaceFirstChar { it.uppercase() }
}

/** Quick-cash buttons: EXACT plus the next round amounts above the total (centavos in, centavos out). */
object QuickCash {
    private val DENOMINATIONS = listOf(20L, 50L, 100L, 200L, 500L, 1000L)
    fun choices(totalMinor: Long): List<Long> {
        if (totalMinor <= 0) return DENOMINATIONS.map { it * 100 }
        val rounded = DENOMINATIONS.map { d -> val step = d * 100; ((totalMinor + step - 1) / step) * step }
        val bills = DENOMINATIONS.map { it * 100 }.filter { it > totalMinor }
        return (rounded + bills).filter { it > totalMinor }.distinct().sorted().take(6)
    }
    fun changeMinor(totalMinor: Long, tenderedMinor: Long): Long = maxOf(0L, tenderedMinor - totalMinor)
    fun shortMinor(totalMinor: Long, tenderedMinor: Long): Long = maxOf(0L, totalMinor - tenderedMinor)
    fun canPay(totalMinor: Long, tenderedMinor: Long?): Boolean = tenderedMinor != null && tenderedMinor >= totalMinor
    /** EXACT: the customer hands over exactly what is due, whatever bill was picked before. The screen shows this at once. */
    fun exactTenderedMinor(cashDueMinor: Long): Long = cashDueMinor
}

/** Money text for big totals: "₱1,234.50". */
object Peso {
    fun format(minor: Long): String = "₱" + String.format(java.util.Locale.US, "%,.2f", BigDecimal.valueOf(minor, 2))
}
