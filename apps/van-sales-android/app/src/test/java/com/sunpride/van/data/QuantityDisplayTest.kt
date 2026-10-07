package com.sunpride.van.data

import org.junit.Assert.*
import org.junit.Test

class QuantityDisplayTest {
    @Test fun baseUnitsUseScaleWithoutLosingIntegerPrecision() {
        val p=Product("p","p","Product","KG",1000,emptyList())
        assertEquals("1.234",p.displayQuantity(1234)); assertEquals("9007199254740.993",p.displayQuantity(9007199254740993L))
    }
}
