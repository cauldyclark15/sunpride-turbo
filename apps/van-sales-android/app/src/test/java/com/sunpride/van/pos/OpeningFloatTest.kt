package com.sunpride.van.pos

import org.junit.Assert.*
import org.junit.Test

/** IP-P0 (SPEC 6.7): the opening float keypad and the wire value. */
class OpeningFloatTest {
    private fun type(vararg keys: String) = keys.fold("") { acc, k -> OpeningFloat.press(acc, k) }

    @Test fun padBuildsWholePesosAndBackspaceRemovesTheLastDigit() {
        assertEquals("2000",type("2","0","0","0"))
        assertEquals("2000",type("2","00","0"))
        assertEquals("200",OpeningFloat.press("2000","back"))
        assertEquals("",OpeningFloat.press("","back"))
    }
    @Test fun leadingZerosNeverStick() {
        assertEquals("",type("0","0","00"))
        assertEquals("5",type("0","5"))
    }
    @Test fun nothingTypedIsNotAFloatButAZeroIsDeliberate() {
        assertNull(OpeningFloat.centavos(""))
        assertEquals(0L,OpeningFloat.centavos("0"))
        assertEquals(200_000L,OpeningFloat.centavos("2000"))
        assertFalse(OpeningFloat.valid(null)); assertTrue(OpeningFloat.valid(0L))
    }
    @Test fun maximumIsOneHundredThousandPesosAndExtraDigitsAreIgnored() {
        assertEquals(10_000_000L,OpeningFloat.centavos("100000"))
        assertEquals("100000",type("1","0","0","0","0","0"))
        assertEquals("100000",OpeningFloat.press("100000","0"))
        assertEquals("100000",OpeningFloat.press("100000","1"))
        assertEquals("10000",OpeningFloat.press("10000","00").take(5))
        assertNull(OpeningFloat.centavos("100001")); assertNull(OpeningFloat.centavos("12a")); assertFalse(OpeningFloat.valid(10_000_001L))
        assertEquals("abc",OpeningFloat.press("abc","x"))
    }
    @Test fun capMessageNamesTheSameRangeTheOfficeEnforces() {
        assertEquals("Opening float must be between ₱0 and ₱100,000",OpeningFloat.CAP_MESSAGE)
        assertEquals(10_000_000L,OpeningFloat.MAX_CENTAVOS)
    }
    @Test fun hintIsShownAsPesosNotPrefilled() {
        assertEquals("₱2,000",OpeningFloat.display(OpeningFloat.HINT_PESOS.toString()))
        assertEquals("₱0",OpeningFloat.display(""))
        assertEquals("₱100,000",OpeningFloat.display("100000"))
        assertEquals("openingFloatCentavos",OpeningFloat.FIELD)
    }
}
