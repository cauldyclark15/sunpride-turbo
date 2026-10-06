package com.sunpride.van.ids

import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class TransactionIdsTest {
    @Test fun numberFormatAndV4KeyAreStableInputsButUniqueIssues() {
        val a = TransactionIds.pair("TRIP-1","ABC12345",1); val b = TransactionIds.pair("TRIP-1","ABC12345",50)
        assertEquals("TRIP-1-ABC12345-0001",a.receiptNumber); assertEquals("TRIP-1-ABC12345-0050",b.receiptNumber)
        assertEquals(4,UUID.fromString(a.idempotencyKey).version()); assertNotEquals(a.idempotencyKey,b.idempotencyKey)
    }
    @Test fun sequenceBeyondFourDigitsNeverTruncatesOrWraps() { assertTrue(TransactionIds.pair("TRIP-1","TAG",10000).receiptNumber.endsWith("10000")) }
    @Test fun deviceTagIsDeterministicAndSpecific() { assertEquals(TransactionIds.deviceTag("d1"),TransactionIds.deviceTag("d1")); assertNotEquals(TransactionIds.deviceTag("d1"),TransactionIds.deviceTag("d2")); assertEquals(8,TransactionIds.deviceTag("d1").length) }
    @Test fun invalidSequencesAreRefused() { assertThrows(IllegalArgumentException::class.java) { TransactionIds.pair("T","D",0) } }
}
