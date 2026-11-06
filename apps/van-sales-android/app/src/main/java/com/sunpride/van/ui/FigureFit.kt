package com.sunpride.van.ui

/**
 * IP-INT3FIX: the big amounts on Payment and Complete (TOTAL, TENDERED, CHANGE) stay on one line and must show every digit.
 * On a 720x1440 handheld the three columns are about 120dp, 95dp and 95dp wide, so "₱476.89" at 34sp / "₱500.00" at 26sp
 * lost the last digit. The size is chosen from the text and the room it has, never smaller than [MIN_SP].
 */
object FigureFit {
    const val MIN_SP = 14f
    /** Width of one character in em for a heavy sans face, a little generous so the last digit never clips. */
    private fun em(c: Char): Float = when {
        c == '₱' -> 0.72f
        c == '.' || c == ',' -> 0.34f
        c == ' ' -> 0.30f
        c.isDigit() -> 0.64f
        else -> 0.66f
    }
    fun widthEm(text: String): Float = text.fold(0f) { w, c -> w + em(c) }

    /** The largest size up to [startSp] whose [text] fits in [availablePx] when one sp is [pxPerSp] pixels. */
    fun sizeSp(text: String, availablePx: Float, pxPerSp: Float, startSp: Float, minSp: Float = MIN_SP): Float {
        if (text.isEmpty() || availablePx <= 0f || pxPerSp <= 0f) return startSp
        val fits = availablePx / (widthEm(text) * pxPerSp)
        return fits.coerceIn(minSp, startSp)
    }
}
