package com.sunpride.van.evidence

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class BaselineJpegTest {
    companion object {
        /** The shared van-v1 evidence fixture: a real 32x24 baseline JPEG with restart markers. */
        fun fixture(): ByteArray = java.util.Base64.getDecoder().decode(JSONObject(BaselineJpegTest::class.java.classLoader!!
            .getResourceAsStream("evidence-request.json")!!.bufferedReader().readText()).getString("dataBase64"))
        /** A valid JPEG grown to exactly [size] bytes with COM segments right after SOI. */
        fun padded(jpeg: ByteArray, size: Int): ByteArray {
            val out = java.io.ByteArrayOutputStream(); out.write(jpeg,0,2)
            var missing = size - jpeg.size
            while (missing > 0) {
                val segment = minOf(missing,65_537); val payload = segment - 4
                require(payload >= 0) { "cannot pad by $missing" }
                out.write(0xff); out.write(0xfe); out.write((payload + 2) shr 8); out.write((payload + 2) and 0xff)
                out.write(ByteArray(payload) { 'x'.code.toByte() }); missing -= segment
            }
            out.write(jpeg,2,jpeg.size - 2); return out.toByteArray()
        }
    }

    @Test fun realBaselineFixtureDecodesWithItsSize() {
        assertEquals(BaselineJpeg.Info(32,24),BaselineJpeg.verify(fixture()))
        assertEquals(BaselineJpeg.Info(32,24),BaselineJpeg.verify(padded(fixture(),96_000)))
    }

    @Test fun signatureOnlyHeaderOnlyTruncatedAndCorruptBytesAreNotPhotos() {
        val jpeg = fixture()
        // The release-check counterexample: SOI + EOI, no picture.
        assertNull(BaselineJpeg.verify(byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),0xd9.toByte())))
        // Every segment but no entropy-coded scan.
        val sos = (2 until jpeg.size - 1).first { jpeg[it] == 0xff.toByte() && jpeg[it + 1] == 0xda.toByte() }
        assertNull(BaselineJpeg.verify(jpeg.copyOfRange(0,sos) + byteArrayOf(0xff.toByte(),0xd9.toByte())))
        // Scan cut short, then a forged EOI.
        assertNull(BaselineJpeg.verify(jpeg.copyOfRange(0,jpeg.size - 40) + byteArrayOf(0xff.toByte(),0xd9.toByte())))
        // Trailing bytes after EOI.
        assertNull(BaselineJpeg.verify(jpeg + byteArrayOf(0)))
        // Progressive frame marker instead of baseline.
        val sof = (2 until jpeg.size - 1).first { jpeg[it] == 0xff.toByte() && jpeg[it + 1] == 0xc0.toByte() }
        assertNull(BaselineJpeg.verify(jpeg.copyOf().also { it[sof + 1] = 0xc2.toByte() }))
        // Random scan bytes (keeping 0xFF out so only Huffman decoding can reject them).
        val random = java.util.Random(7)
        val garbage = jpeg.copyOf().also { for (i in sos + 14 until it.size - 2) it[i] = (random.nextInt(0xfe)).toByte() }
        assertNull(BaselineJpeg.verify(garbage))
    }

    /**
     * The fixture with one extra symbol appended to its luminance DC Huffman table at code
     * length [length]; the scan still decodes identically. At length 9 the table becomes
     * complete and the new symbol takes the reserved all-ones code; at length 10 it does not.
     */
    private fun withExtraDcSymbol(length: Int): ByteArray {
        val jpeg = fixture()
        val at = (2 until jpeg.size - 4).first { jpeg[it] == 0xff.toByte() && jpeg[it + 1] == 0xc4.toByte() && jpeg[it + 4] == 0.toByte() }
        val counts = jpeg.copyOfRange(at + 5,at + 21); val total = counts.sumOf { it.toInt() and 0xff }
        counts[length - 1] = (counts[length - 1] + 1).toByte()
        val segment = ((jpeg[at + 2].toInt() and 0xff) shl 8 or (jpeg[at + 3].toInt() and 0xff)) + 1
        return jpeg.copyOfRange(0,at + 2) + byteArrayOf((segment shr 8).toByte(),segment.toByte(),0) + counts +
            jpeg.copyOfRange(at + 21,at + 21 + total) + byteArrayOf(0) + jpeg.copyOfRange(at + 21 + total,jpeg.size)
    }

    @Test fun huffmanTableUsingTheReservedAllOnesCodeIsRefused() {
        // Control: the same edit leaving the table incomplete still decodes.
        assertEquals(BaselineJpeg.Info(32,24),BaselineJpeg.verify(withExtraDcSymbol(10)))
        // Release-check counterexample: a complete table, which libjpeg refuses.
        assertNull(BaselineJpeg.verify(withExtraDcSymbol(9)))
    }

    @Test fun picturesSmallerOrLargerThanTheBoundsAreRefused() {
        assertNull(BaselineJpeg.verify(fixture(),minSide = 25))
        assertNull(BaselineJpeg.verify(fixture(),maxSide = 31))
    }
}
