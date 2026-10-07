package com.sunpride.van.evidence

/**
 * VAN-020: a damage photo must be a real, bounded picture, not bytes that merely start and
 * end with JPEG markers. Decodes a baseline (sequential Huffman) JPEG far enough to prove
 * every 8x8 block of every component is present and well formed: frame, quantization and
 * Huffman tables, the full entropy-coded scan with its restart markers, and the final EOI
 * (no inverse DCT). Progressive, arithmetic, lossless and 12-bit files are refused; the app
 * only produces baseline (Bitmap.compress). Mirror of backend `convex/van/jpeg.ts`.
 */
object BaselineJpeg {
    data class Info(val width: Int, val height: Int)
    const val MIN_SIDE = 16
    const val MAX_SIDE = 4096

    private class Invalid : RuntimeException()
    private fun fail(): Nothing = throw Invalid()

    private class Huffman(counts: IntArray, val values: IntArray) {
        val maxCode = IntArray(18) { -1 }; val valPtr = IntArray(17); val minCode = IntArray(17)
        init {
            var code = 0; var k = 0
            for (length in 1..16) {
                val n = counts[length - 1]
                if (n > 0) {
                    valPtr[length] = k; minCode[length] = code; code += n; k += n
                    // Overflow is not a prefix code; the all-ones code of a length is reserved
                    // (T.81 Annex C), so a complete table is refused as libjpeg does.
                    if (code >= (1 shl length)) fail()
                    maxCode[length] = code - 1
                }
                code = code shl 1
            }
        }
    }
    private class Component(val id: Int, val h: Int, val v: Int, val tq: Int)
    private class Frame(val width: Int, val height: Int, val components: List<Component>)
    private class ScanEntry(val c: Component, val dc: Huffman, val ac: Huffman)

    private class Bits(val data: ByteArray, var pos: Int) {
        private var bit = 0; private var byte = 0
        fun read(): Int {
            if (bit == 0) {
                if (pos >= data.size) fail()
                val b = data[pos].toInt() and 0xff
                if (b == 0xff) { if (pos + 1 >= data.size || data[pos + 1].toInt() != 0) fail(); pos += 2 } else pos += 1
                byte = b; bit = 8
            }
            bit -= 1
            return (byte shr bit) and 1
        }
        fun receive(count: Int) { repeat(count) { read() } }
        fun decode(t: Huffman): Int {
            var code = 0
            for (length in 1..16) {
                code = (code shl 1) or read()
                if (code <= t.maxCode[length]) return t.values[t.valPtr[length] + code - t.minCode[length]]
            }
            fail()
        }
        fun align() { bit = 0 }
    }

    private fun decodeBlock(bits: Bits, dc: Huffman, ac: Huffman) {
        val size = bits.decode(dc); if (size > 11) fail(); bits.receive(size)
        var k = 1
        while (k < 64) {
            val rs = bits.decode(ac); val run = rs shr 4; val s = rs and 15
            if (s == 0) { if (run != 15) return; k += 16; if (k > 64) fail(); continue }
            if (s > 10) fail()
            k += run; if (k > 63) fail()
            bits.receive(s); k += 1
        }
    }

    /** The picture size, or null when [data] is not a complete baseline JPEG within bounds. */
    fun verify(data: ByteArray, minSide: Int = MIN_SIDE, maxSide: Int = MAX_SIDE): Info? =
        try { parse(data, minSide, maxSide) } catch (_: Invalid) { null } catch (_: IndexOutOfBoundsException) { null }

    private fun parse(data: ByteArray, minSide: Int, maxSide: Int): Info {
        fun u(at: Int): Int { if (at >= data.size) fail(); return data[at].toInt() and 0xff }
        fun u16(at: Int) = (u(at) shl 8) or u(at + 1)
        if (data.size < 4 || u(0) != 0xff || u(1) != 0xd8) fail()
        val quant = mutableSetOf<Int>()
        val dcTables = arrayOfNulls<Huffman>(4); val acTables = arrayOfNulls<Huffman>(4)
        var frame: Frame? = null
        val scanned = mutableSetOf<Int>()
        var restartInterval = 0
        var pos = 2
        while (true) {
            if (pos >= data.size || u(pos) != 0xff) fail()
            while (pos < data.size && u(pos) == 0xff) pos += 1
            val marker = u(pos); pos += 1
            if (marker == 0xd9) {
                val f = frame ?: fail()
                if (pos != data.size || scanned.size != f.components.size) fail()
                return Info(f.width, f.height)
            }
            if (marker == 0x00 || marker == 0x01 || marker in 0xd0..0xd8) fail()
            val length = u16(pos)
            if (length < 2 || pos + length > data.size) fail()
            val start = pos + 2; val end = pos + length
            pos = end
            when {
                marker == 0xc0 || marker == 0xc1 -> {
                    if (frame != null || length < 8 || u(start) != 8) fail()
                    val height = u16(start + 1); val width = u16(start + 3); val count = u(start + 5)
                    if ((count != 1 && count != 3) || length != 8 + count * 3) fail()
                    if (width < minSide || height < minSide || width > maxSide || height > maxSide) fail()
                    val components = mutableListOf<Component>()
                    for (i in 0 until count) {
                        val at = start + 6 + i * 3
                        val h = u(at + 1) shr 4; val v = u(at + 1) and 15; val tq = u(at + 2)
                        if (h !in 1..4 || v !in 1..4 || tq > 3 || components.any { it.id == u(at) }) fail()
                        components += Component(u(at), h, v, tq)
                    }
                    frame = Frame(width, height, components)
                }
                marker in 0xc2..0xcf && marker != 0xc4 && marker != 0xc8 && marker != 0xcc -> fail()
                marker == 0xc4 -> {
                    var at = start
                    while (at < end) {
                        val tc = u(at) shr 4; val th = u(at) and 15
                        if (tc > 1 || th > 3 || at + 17 > end) fail()
                        val counts = IntArray(16) { u(at + 1 + it) }; val total = counts.sum()
                        if (total == 0 || total > 256 || at + 17 + total > end) fail()
                        val table = Huffman(counts, IntArray(total) { u(at + 17 + it) })
                        if (tc == 0) dcTables[th] = table else acTables[th] = table
                        at += 17 + total
                    }
                }
                marker == 0xdb -> {
                    var at = start
                    while (at < end) {
                        val size = when (u(at) shr 4) { 0 -> 64; 1 -> 128; else -> fail() }
                        val tq = u(at) and 15
                        if (tq > 3 || at + 1 + size > end) fail()
                        quant += tq; at += 1 + size
                    }
                }
                marker == 0xdd -> { if (length != 4) fail(); restartInterval = u16(start) }
                marker == 0xda -> {
                    val f = frame ?: fail()
                    val count = u(start)
                    if (count < 1 || count > f.components.size || length != 6 + count * 2) fail()
                    val scan = (0 until count).map { i ->
                        val at = start + 1 + i * 2
                        val c = f.components.firstOrNull { it.id == u(at) } ?: fail()
                        if (c.id in scanned || c.tq !in quant) fail()
                        val dc = dcTables[u(at + 1) shr 4] ?: fail(); val ac = acTables[u(at + 1) and 15] ?: fail()
                        scanned += c.id
                        ScanEntry(c, dc, ac)
                    }
                    val tail = start + 1 + count * 2
                    if (u(tail) != 0 || u(tail + 1) != 63 || u(tail + 2) != 0) fail()
                    pos = decodeScan(data, end, f, scan, restartInterval)
                }
                else -> Unit // APPn, COM and other skippable segments
            }
        }
    }

    private fun ceilDiv(a: Int, b: Int) = (a + b - 1) / b

    private fun decodeScan(data: ByteArray, from: Int, f: Frame, scan: List<ScanEntry>, restartInterval: Int): Int {
        val hMax = f.components.maxOf { it.h }; val vMax = f.components.maxOf { it.v }
        val units: Int; val perUnit: List<Pair<ScanEntry, Int>>
        if (scan.size == 1) {
            val c = scan[0].c
            units = ceilDiv(ceilDiv(f.width * c.h, hMax), 8) * ceilDiv(ceilDiv(f.height * c.v, vMax), 8)
            perUnit = listOf(scan[0] to 1)
        } else {
            units = ceilDiv(f.width, 8 * hMax) * ceilDiv(f.height, 8 * vMax)
            perUnit = scan.map { it to it.c.h * it.c.v }
            if (perUnit.sumOf { it.second } > 10) fail()
        }
        val bits = Bits(data, from)
        var expectedRestart = 0
        for (unit in 0 until units) {
            if (restartInterval > 0 && unit > 0 && unit % restartInterval == 0) {
                bits.align()
                if (bits.pos + 1 >= data.size || (data[bits.pos].toInt() and 0xff) != 0xff ||
                    (data[bits.pos + 1].toInt() and 0xff) != 0xd0 + expectedRestart) fail()
                bits.pos += 2; expectedRestart = (expectedRestart + 1) and 7
            }
            for ((entry, count) in perUnit) repeat(count) { decodeBlock(bits, entry.dc, entry.ac) }
        }
        bits.align()
        if (bits.pos >= data.size || (data[bits.pos].toInt() and 0xff) != 0xff) fail()
        return bits.pos
    }
}
