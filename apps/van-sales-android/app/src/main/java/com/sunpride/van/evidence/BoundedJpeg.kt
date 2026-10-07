package com.sunpride.van.evidence

/** Deterministic quality/size search shared by Android Bitmap encoding and JVM ImageIO tests. */
object BoundedJpeg {
    fun encode(width: Int, height: Int, maxBytes: Int, encode: (Int,Int,Int) -> ByteArray): ByteArray {
        require(width > 0 && height > 0 && maxBytes in 1024..96_000)
        val ratio = minOf(1.0,1024.0 / maxOf(width,height))
        var w = maxOf(1,(width * ratio).toInt()); var h = maxOf(1,(height * ratio).toInt())
        while (true) {
            for (quality in listOf(85,70,55,40,25,10)) {
                val bytes = encode(w,h,quality)
                if (bytes.isNotEmpty() && bytes.size <= maxBytes) return bytes
            }
            check(w > 1 || h > 1) { "Could not fit photo" }
            w = maxOf(1,w * 3 / 4); h = maxOf(1,h * 3 / 4)
        }
    }
}
