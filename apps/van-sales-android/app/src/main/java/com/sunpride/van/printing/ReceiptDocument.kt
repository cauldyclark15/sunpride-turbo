package com.sunpride.van.printing

import java.math.BigDecimal
import java.math.RoundingMode

/** Vendor-neutral, immutable receipt data. Text is wrapped, never silently truncated. */
data class ReceiptDocument(val elements: List<ReceiptElement>, val isReprint: Boolean = false) {
    fun markedReprint(): ReceiptDocument = copy(isReprint = true)
}

enum class ReceiptAlignment { LEFT, CENTER, RIGHT }
data class ReceiptStyle(
    val alignment: ReceiptAlignment = ReceiptAlignment.LEFT,
    val bold: Boolean = false,
    val doubleWidth: Boolean = false,
    val doubleHeight: Boolean = false,
)
enum class ReceiptBarcodeType { CODE_128, EAN_13, EAN_8, UPC_A, UPC_E }
sealed interface ReceiptElement {
    data class Text(val text: String, val style: ReceiptStyle = ReceiptStyle()) : ReceiptElement
    data class Columns(val label: String, val value: String, val bold: Boolean = false) : ReceiptElement
    data class Divider(val character: Char = '-') : ReceiptElement {
        init { require(character >= ' ' && character != '\u007f') }
    }
    data class Qr(val data: String, val moduleSize: Int = 6, val errorLevel: Int = 1) : ReceiptElement {
        init { require(data.isNotEmpty()); require(moduleSize in 1..8); require(errorLevel in 0..3) }
    }
    data class Barcode(
        val data: String,
        val type: ReceiptBarcodeType = ReceiptBarcodeType.CODE_128,
        val height: Int = 80,
    ) : ReceiptElement {
        init { require(data.isNotEmpty()); require(height in 24..255) }
    }
    data class Feed(val lines: Int = 3) : ReceiptElement {
        init { require(lines in 0..20) }
    }
}

object PesoAmounts {
    /** ASCII P is deliberate: a successful Binder call cannot prove the physical ₱ glyph. */
    fun format(amount: BigDecimal): String = "P" + amount.setScale(2, RoundingMode.HALF_UP).toPlainString()
    fun fromCentavos(centavos: Long): String = format(BigDecimal.valueOf(centavos, 2))
}
