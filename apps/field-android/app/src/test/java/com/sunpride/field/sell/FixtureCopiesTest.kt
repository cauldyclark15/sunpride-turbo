package com.sunpride.field.sell

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/** SP-0192: the money and quantity fixtures the Sell area is held to are byte-identical to the server's copies. */
class FixtureCopiesTest {
    private fun mine(name: String) = checkNotNull(javaClass.getResourceAsStream("/$name")).bufferedReader().use { it.readText() }
    private fun server(name: String) = File("../../api/test/fixtures/$name").readText()
    @Test fun privilegeCapVectorsAreTheServerCopy() = assertEquals(server("privilege-cap-vectors.json"), mine("privilege-cap-vectors.json"))
    @Test fun phoneQuantityWireIsTheServerCopy() = assertEquals(server("phone-quantity-wire.json"), mine("phone-quantity-wire.json"))
}
