package com.sunpride.van.printing.escpos

import com.sunpride.van.printing.ReceiptAlignment
import com.sunpride.van.printing.ReceiptBarcodeType
import com.sunpride.van.printing.ReceiptDocument
import com.sunpride.van.printing.ReceiptElement
import com.sunpride.van.printing.ReceiptStyle
import com.sunpride.van.printing.TestReceipts
import java.time.ZonedDateTime
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class EscPosEncoderTest {
    private val encoder = EscPosEncoder()

    private fun ByteArray.indexOf(part: ByteArray): Int =
        (0..size - part.size).firstOrNull { start -> part.indices.all { this[start + it] == part[it] } } ?: -1
    private fun ByteArray.contains(part: ByteArray) = indexOf(part) >= 0
    private fun bytes(vararg values: Int) = ByteArray(values.size) { values[it].toByte() }

    @Test fun startsWithInitAndCodePageAndEndsWithPlainStyle() {
        val out = encoder.encode(ReceiptDocument(listOf(ReceiptElement.Text("Hi"))))
        assertArrayEquals(bytes(0x1b, 0x40, 0x1b, 0x74, 0), out.copyOfRange(0, 5))
        assertArrayEquals(encoder.style(ReceiptStyle()), out.copyOfRange(out.size - 9, out.size))
        assertTrue(out.contains("Hi\n".toByteArray()))
    }

    @Test fun stylesMapToAlignBoldAndSize() {
        assertArrayEquals(bytes(0x1b, 0x61, 1, 0x1b, 0x45, 1, 0x1d, 0x21, 0x11),
            encoder.style(ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleWidth = true, doubleHeight = true)))
        assertArrayEquals(bytes(0x1b, 0x61, 2, 0x1b, 0x45, 0, 0x1d, 0x21, 0x01),
            encoder.style(ReceiptStyle(ReceiptAlignment.RIGHT, doubleHeight = true)))
    }

    @Test fun sunprideTestReceiptKeepsEveryLineAndAmount() {
        val doc = TestReceipts.build("MPT-II", "ESC/POS", ZonedDateTime.parse("2026-10-07T09:00:00+08:00"))
        val text = String(encoder.encode(doc), Charsets.ISO_8859_1)
        listOf("SUNPRIDE VAN SALES", "TEST RECEIPT - NOT AN OFFICIAL", "Device: MPT-II", "P374.50", "Delivery receipt only.")
            .forEach { assertTrue("missing $it", text.contains(it)) }
        // 32-column total line, right-aligned amount.
        assertTrue(text.contains("TOTAL" + " ".repeat(32 - 5 - 7) + "P374.50\n"))
    }

    @Test fun eightyMillimetreLayoutUsesFortyEightColumns() {
        val wide = EscPosEncoder(columns = 48, dotsPerLine = 576)
        val text = String(wide.encode(ReceiptDocument(listOf(ReceiptElement.Divider()))), Charsets.ISO_8859_1)
        assertTrue(text.contains("-".repeat(48) + "\n"))
        assertFalse(text.contains("-".repeat(49)))
    }

    @Test fun reprintBannerIsPrinted() {
        val text = String(encoder.encode(ReceiptDocument(listOf(ReceiptElement.Text("x")), isReprint = true)), Charsets.ISO_8859_1)
        assertTrue(text.contains("REPRINT\n"))
    }

    @Test fun textIsSafeForThePrinter() {
        assertArrayEquals("Pena".toByteArray(), encoder.text("Pe\u0303na")) // stray combining accent dropped
        assertArrayEquals(bytes('P'.code, 0xa4, 'a'.code), encoder.text("Pña"))
        assertArrayEquals(bytes(0xa5), encoder.text("Ñ"))
        assertArrayEquals("P100".toByteArray(), encoder.text("₱100"))
        assertArrayEquals("Sao".toByteArray(), encoder.text("São"))
        // Control characters must never reach the printer as commands.
        assertArrayEquals("?@? ".toByteArray(), encoder.text("\u001b@\u0007\t"))
        assertArrayEquals("?".toByteArray(), encoder.text("😀"))
    }

    @Test fun qrUsesModelTwoSizeLevelAndStoredLength() {
        val qr = encoder.qr(ReceiptElement.Qr("SR-0001", moduleSize = 6, errorLevel = 1))
        assertArrayEquals(bytes(0x1d, 0x28, 0x6b, 4, 0, 49, 65, 50, 0), qr.copyOfRange(0, 9))
        assertArrayEquals(bytes(0x1d, 0x28, 0x6b, 3, 0, 49, 67, 6), qr.copyOfRange(9, 17))
        assertArrayEquals(bytes(0x1d, 0x28, 0x6b, 3, 0, 49, 69, 49), qr.copyOfRange(17, 25))
        assertArrayEquals(bytes(0x1d, 0x28, 0x6b, 10, 0, 49, 80, 48), qr.copyOfRange(25, 33))
        assertEquals("SR-0001", String(qr.copyOfRange(33, 40)))
        assertArrayEquals(bytes(0x1d, 0x28, 0x6b, 3, 0, 49, 81, 48), qr.copyOfRange(40, 48))
        try { encoder.qr(ReceiptElement.Qr("x".repeat(701))); fail() } catch (_: EscPosEncodingException) { }
    }

    @Test fun barcodesAreValidatedAndSizedBeforeSending() {
        val code = encoder.barcode(ReceiptElement.Barcode("SR{1", height = 60))
        assertTrue(code.contains(bytes(0x1d, 0x68, 60)))
        assertTrue(code.contains(bytes(0x1d, 0x77, 3)))
        assertTrue(code.contains(bytes(0x1d, 0x6b, 73, 7) + "{BSR{{1".toByteArray()))
        val ean = encoder.barcode(ReceiptElement.Barcode("4006381333931", ReceiptBarcodeType.EAN_13))
        assertTrue(ean.contains(bytes(0x1d, 0x6b, 67, 13) + "4006381333931".toByteArray()))
        encoder.barcode(ReceiptElement.Barcode("96385074", ReceiptBarcodeType.EAN_8))
        listOf(
            ReceiptElement.Barcode("4006381333932", ReceiptBarcodeType.EAN_13), // bad check digit
            ReceiptElement.Barcode("48000A", ReceiptBarcodeType.EAN_8),
            ReceiptElement.Barcode("ñ"),
            ReceiptElement.Barcode("X".repeat(20)), // too wide for 58mm
        ).forEach { bad ->
            try { encoder.barcode(bad); fail("accepted $bad") } catch (_: EscPosEncodingException) { }
        }
        // The same 20-character code fits on 80mm paper.
        EscPosEncoder(48, 576).barcode(ReceiptElement.Barcode("X".repeat(20)))
    }

    @Test fun feedUsesEscD() {
        assertTrue(encoder.encode(ReceiptDocument(listOf(ReceiptElement.Feed(4)))).contains(bytes(0x1b, 0x64, 4)))
    }

    @Test fun paperStatusReplyIsParsedStrictly() {
        assertEquals(false, EscPosEncoder.paperOut(0x12))
        assertEquals(true, EscPosEncoder.paperOut(0x72))
        assertEquals(false, EscPosEncoder.paperOut(0x1e)) // near end is still printable
        assertNull(EscPosEncoder.paperOut(0x00))
        assertNull(EscPosEncoder.paperOut(0xff))
        assertEquals(1, EscPosEncoder.checkDigit("400638133393"))
        assertEquals(4, EscPosEncoder.checkDigit("9638507"))
    }
}
