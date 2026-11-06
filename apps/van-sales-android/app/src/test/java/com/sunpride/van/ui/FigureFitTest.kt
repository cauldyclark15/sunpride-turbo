package com.sunpride.van.ui

import org.junit.Assert.*
import org.junit.Test

/** IP-INT3FIX: TOTAL and TENDERED on a 720x1440 handheld lost their last digit ("₱476.8", "₱500.0"). */
class FigureFitTest {
    // 720 px wide, 2x density: the payment card gives its three columns about 246, 189 and 189 px.
    private val pxPerSp = 2f
    private fun width(text: String, sp: Float) = FigureFit.widthEm(text) * sp * pxPerSp

    @Test fun totalAndTenderedFitTheirColumnsOn720Wide() {
        for ((text, start, room) in listOf(Triple("₱476.89", 34f, 246f), Triple("₱500.00", 26f, 189f), Triple("₱23.11", 26f, 189f))) {
            val sp = FigureFit.sizeSp(text, room, pxPerSp, start)
            assertTrue("$text at $sp sp is ${width(text, sp)} px in $room", width(text, sp) <= room + 0.5f)
            assertTrue("$text must not shrink to nothing", sp >= FigureFit.MIN_SP)
        }
    }
    @Test fun theOldFixedSizesDidNotFit() {
        // what shipped in beta.27: 34sp and 26sp whatever the room
        assertTrue(width("₱476.89", 34f) > 246f)
        assertTrue(width("₱500.00", 26f) > 189f)
    }
    @Test fun roomyScreensKeepTheBigSizeAndBigAmountsStillShow() {
        assertEquals(34f, FigureFit.sizeSp("₱476.89", 900f, pxPerSp, 34f), 0.001f)
        val sp = FigureFit.sizeSp("₱1,234,567.89", 246f, pxPerSp, 34f)
        assertTrue(sp >= FigureFit.MIN_SP && sp < 34f)
    }
    @Test fun noWidthYetOrNoTextKeepsTheStartSize() {
        assertEquals(26f, FigureFit.sizeSp("₱1.00", 0f, pxPerSp, 26f), 0f)
        assertEquals(26f, FigureFit.sizeSp("", 100f, pxPerSp, 26f), 0f)
    }
}
