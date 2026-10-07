package com.sunpride.van.printing.escpos

import com.sunpride.van.printing.ReceiptAlignment
import com.sunpride.van.printing.ReceiptBarcodeType
import com.sunpride.van.printing.ReceiptCommand
import com.sunpride.van.printing.ReceiptDocument
import com.sunpride.van.printing.ReceiptElement
import com.sunpride.van.printing.ReceiptLayoutFormatter
import com.sunpride.van.printing.ReceiptStyle
import java.io.ByteArrayOutputStream
import java.text.Normalizer

/** A receipt that cannot be printed as asked (bad barcode, QR too long). Raised before any byte is sent. */
class EscPosEncodingException(message: String) : IllegalArgumentException(message)

/**
 * VAN-015: turns the vendor-neutral receipt into the generic ESC/POS command set that cheap 58mm/80mm
 * Bluetooth printers understand (Epson TM-compatible subset: ESC @, ESC a, ESC E, GS !, ESC d, GS ( k, GS k).
 * Pure JVM code, so the bytes are unit-tested without a printer.
 *
 * The whole job is encoded up front; an invalid barcode/QR throws [EscPosEncodingException] before
 * anything reaches the printer, so a bad receipt never prints half way.
 */
class EscPosEncoder(val columns: Int = 32, val dotsPerLine: Int = 384) {
    private val formatter = ReceiptLayoutFormatter(columns)

    fun encode(document: ReceiptDocument): ByteArray = encodeCommands(formatter.format(document))

    fun encodeCommands(commands: List<ReceiptCommand>): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(INIT)
        out.write(CODE_PAGE_PC437)
        for (command in commands) {
            when (command) {
                is ReceiptCommand.Line -> {
                    out.write(style(command.style))
                    out.write(text(command.text))
                    out.write(LF.toInt())
                }
                is ReceiptCommand.Qr -> {
                    out.write(style(ReceiptStyle(ReceiptAlignment.CENTER)))
                    out.write(qr(command.value))
                    out.write(LF.toInt())
                }
                is ReceiptCommand.Barcode -> {
                    out.write(style(ReceiptStyle(ReceiptAlignment.CENTER)))
                    out.write(barcode(command.value))
                    out.write(LF.toInt())
                }
                is ReceiptCommand.Feed -> {
                    out.write(style(ReceiptStyle()))
                    if (command.lines > 0) out.write(byteArrayOf(ESC, 'd'.code.toByte(), command.lines.toByte()))
                }
            }
        }
        out.write(style(ReceiptStyle()))
        return out.toByteArray()
    }

    fun style(style: ReceiptStyle): ByteArray {
        val size = (if (style.doubleWidth) 0x10 else 0) or (if (style.doubleHeight) 0x01 else 0)
        return byteArrayOf(
            ESC, 'a'.code.toByte(), style.alignment.ordinal.toByte(),
            ESC, 'E'.code.toByte(), if (style.bold) 1 else 0,
            GS, '!'.code.toByte(), size.toByte(),
        )
    }

    /** Code page PC437: ASCII as is, common Filipino/Spanish letters (ñ, é) mapped, other accents stripped, the rest '?'. */
    fun text(value: String): ByteArray {
        val out = ByteArrayOutputStream()
        value.codePoints().forEach { point ->
            when {
                point == '\t'.code -> out.write(' '.code)
                point in 0x20..0x7e -> out.write(point)
                point < 0x20 || point == 0x7f -> out.write('?'.code) // control bytes would be printer commands
                Character.getType(point) == Character.NON_SPACING_MARK.toInt() -> Unit // stray combining accent
                PC437[point] != null -> out.write(PC437.getValue(point))
                point == '₱'.code -> out.write('P'.code)
                else -> {
                    val stripped = Normalizer.normalize(String(Character.toChars(point)), Normalizer.Form.NFD)
                        .filter { it.code in 0x20..0x7e }
                    if (stripped.isEmpty()) out.write('?'.code) else out.write(stripped.toByteArray(Charsets.US_ASCII))
                }
            }
        }
        return out.toByteArray()
    }

    /** Native QR (GS ( k, model 2). Error levels 0..3 = L, M, Q, H as on the H10P service. */
    fun qr(value: ReceiptElement.Qr): ByteArray {
        val data = value.data.toByteArray(Charsets.UTF_8)
        if (data.size > MAX_QR_BYTES) throw EscPosEncodingException("QR data is too long for this printer")
        val store = data.size + 3
        return ByteArrayOutputStream().apply {
            write(byteArrayOf(GS, '('.code.toByte(), 'k'.code.toByte(), 4, 0, 49, 65, 50, 0)) // model 2
            write(byteArrayOf(GS, '('.code.toByte(), 'k'.code.toByte(), 3, 0, 49, 67, value.moduleSize.toByte()))
            write(byteArrayOf(GS, '('.code.toByte(), 'k'.code.toByte(), 3, 0, 49, 69, (48 + value.errorLevel).toByte()))
            write(byteArrayOf(GS, '('.code.toByte(), 'k'.code.toByte(), (store and 0xff).toByte(), (store shr 8).toByte(), 49, 80, 48))
            write(data)
            write(byteArrayOf(GS, '('.code.toByte(), 'k'.code.toByte(), 3, 0, 49, 81, 48)) // print
        }.toByteArray()
    }

    /** 1D barcode (GS k, format B), validated and sized to the paper before sending. Human-readable digits below. */
    fun barcode(value: ReceiptElement.Barcode): ByteArray {
        val (system, payload, modules) = when (value.type) {
            ReceiptBarcodeType.CODE_128 -> {
                if (value.data.any { it.code !in 0x20..0x7e }) throw EscPosEncodingException("Code 128 accepts printable ASCII only")
                val escaped = "{B" + value.data.replace("{", "{{")
                Triple(73, escaped, (value.data.length + 3) * 11 + 2)
            }
            ReceiptBarcodeType.EAN_13 -> Triple(67, gtin(value.data, 13), 95)
            ReceiptBarcodeType.EAN_8 -> Triple(68, gtin(value.data, 8), 67)
            ReceiptBarcodeType.UPC_A -> Triple(65, gtin(value.data, 12), 95)
            ReceiptBarcodeType.UPC_E -> {
                if (!value.data.all(Char::isDigit) || value.data.length !in setOf(6, 7, 8, 11, 12)) {
                    throw EscPosEncodingException("UPC-E needs 6-8, 11 or 12 digits")
                }
                Triple(66, value.data, 51)
            }
        }
        val bytes = payload.toByteArray(Charsets.US_ASCII)
        if (bytes.size > 255) throw EscPosEncodingException("Barcode is too long")
        // Quiet zones (10 modules each side) must fit too. Module width 3, else 2; 1 is not supported everywhere.
        val width = listOf(3, 2).firstOrNull { (modules + 20) * it <= dotsPerLine }
            ?: throw EscPosEncodingException("Barcode is too wide for ${dotsPerLine / 8}mm print width")
        return ByteArrayOutputStream().apply {
            write(byteArrayOf(GS, 'h'.code.toByte(), value.height.toByte()))
            write(byteArrayOf(GS, 'w'.code.toByte(), width.toByte()))
            write(byteArrayOf(GS, 'H'.code.toByte(), 2)) // digits below
            write(byteArrayOf(GS, 'f'.code.toByte(), 0))
            write(byteArrayOf(GS, 'k'.code.toByte(), system.toByte(), bytes.size.toByte()))
            write(bytes)
        }.toByteArray()
    }

    private fun gtin(data: String, length: Int): String {
        if (!data.all(Char::isDigit) || data.length !in setOf(length - 1, length)) {
            throw EscPosEncodingException("Barcode needs ${length - 1} or $length digits")
        }
        if (data.length == length && checkDigit(data.dropLast(1)) != data.last().digitToInt()) {
            throw EscPosEncodingException("Barcode check digit is wrong")
        }
        return data
    }

    companion object {
        const val ESC: Byte = 0x1b
        const val GS: Byte = 0x1d
        const val DLE: Byte = 0x10
        const val EOT: Byte = 0x04
        const val LF: Byte = 0x0a
        const val MAX_QR_BYTES = 700
        val INIT = byteArrayOf(ESC, '@'.code.toByte())
        val CODE_PAGE_PC437 = byteArrayOf(ESC, 't'.code.toByte(), 0)
        /** DLE EOT 4: real-time paper roll sensor status (one byte back, if the printer supports it). */
        val PAPER_STATUS_REQUEST = byteArrayOf(DLE, EOT, 4)
        /** GS V 66 n: feed n lines and (partial) cut. Only sent to printers configured with a cutter. */
        val FEED_AND_CUT = byteArrayOf(GS, 'V'.code.toByte(), 66, 3)

        fun checkDigit(body: String): Int {
            val sum = body.reversed().mapIndexed { index, c -> c.digitToInt() * if (index % 2 == 0) 3 else 1 }.sum()
            return (10 - sum % 10) % 10
        }

        /** Parses the DLE EOT 4 reply; null when the byte is not a valid status (fixed bits 1 and 4 set, 0 and 7 clear). */
        fun paperOut(reply: Int): Boolean? {
            if (reply and 0x93 != 0x12) return null
            return reply and 0x60 != 0
        }

        private val PC437 = mapOf(
            'Ç'.code to 0x80, 'ü'.code to 0x81, 'é'.code to 0x82, 'â'.code to 0x83, 'ä'.code to 0x84, 'à'.code to 0x85,
            'ç'.code to 0x87, 'ê'.code to 0x88, 'ë'.code to 0x89, 'è'.code to 0x8a, 'ï'.code to 0x8b, 'î'.code to 0x8c,
            'ì'.code to 0x8d, 'Ä'.code to 0x8e, 'É'.code to 0x90, 'ô'.code to 0x93, 'ö'.code to 0x94, 'ò'.code to 0x95,
            'û'.code to 0x96, 'ù'.code to 0x97, 'Ö'.code to 0x99, 'Ü'.code to 0x9a, 'á'.code to 0xa0, 'í'.code to 0xa1,
            'ó'.code to 0xa2, 'ú'.code to 0xa3, 'ñ'.code to 0xa4, 'Ñ'.code to 0xa5, '¿'.code to 0xa8, '¡'.code to 0xad,
        )
    }
}
