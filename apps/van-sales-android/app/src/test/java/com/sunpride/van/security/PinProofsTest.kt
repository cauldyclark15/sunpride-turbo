package com.sunpride.van.security

import org.junit.Assert.*
import org.junit.Test

class PinProofsTest {
    private class MemoryStorage : LockoutStorage {
        val map = mutableMapOf<String, List<Long>>()
        override fun load(key: String) = map[key].orEmpty()
        override fun save(key: String, failures: List<Long>) { map[key] = failures }
    }
    // Few rounds: the maths is the same, the test stays fast.
    private fun verifier(pin: String, salt: String): String {
        val key = PinProofs.derive(pin, salt, 1000)
        return java.security.MessageDigest.getInstance("SHA-256").digest(key).joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    /** Values produced by the SERVER's own `overrideProof` / `crewProof` (storepos/overrides.js, van/roster.js) for the same PIN, salt and action. */
    @Test fun matchesTheServersOwnProofsForTheSamePinAndAction() {
        val salt = "00112233445566778899aabbccddeeff"
        assertEquals("0ffd446ec9bcfa8a434d9419bc227c24ce80fc81be4dec8a77075d3ea515d600",
            PinProofs.signIfValid("123456", salt, "8885b49de1b8de3043b2062e032bfdee57268c0a68bb139189e0f609eadc52ed",
                PinProofs.overrideMessage("cash_drop", "op-1", "shift-1", "500000", "pin-1")))
        assertEquals("a0309c90a670360e42b72f51f39153080486402abe492bae1faff9a7bad29871",
            PinProofs.signIfValid("123456", salt, "8885b49de1b8de3043b2062e032bfdee57268c0a68bb139189e0f609eadc52ed",
                PinProofs.crewMessage("dev-1", "trip-1", "person-1", "pin-9", 1_700_000_000_000L)))
        assertNull(PinProofs.signIfValid("123457", salt, "8885b49de1b8de3043b2062e032bfdee57268c0a68bb139189e0f609eadc52ed", "x"))
    }

    @Test fun theMessageNamesTheActionTheAmountAndThePinVersion() {
        assertEquals("override|cash_drop|op-1|shift-1|500000|pin-1", PinProofs.overrideMessage("cash_drop", "op-1", "shift-1", "500000", "pin-1"))
        assertEquals("override|no_sale|op-2||0|pin-1", PinProofs.overrideMessage("no_sale", "op-2", null, null, "pin-1"))
        assertEquals("crew|dev|trip|person|pin-9|1700000000000", PinProofs.crewMessage("dev", "trip", "person", "pin-9", 1_700_000_000_000L))
    }

    @Test fun aProofChangesWithAnyPartOfTheMessageSoItCannotBeReusedForAnotherAction() {
        val key = PinProofs.derive("123456", "00112233445566778899aabbccddeeff", 1000)
        val a = PinProofs.hmacHex(key, PinProofs.overrideMessage("cash_drop", "op-1", "s", "500000", "p"))
        val b = PinProofs.hmacHex(key, PinProofs.overrideMessage("cash_drop", "op-1", "s", "500001", "p"))
        val c = PinProofs.hmacHex(key, PinProofs.overrideMessage("cash_drop", "op-2", "s", "500000", "p"))
        assertEquals(64, a.length); assertNotEquals(a, b); assertNotEquals(a, c)
        assertEquals(a, PinProofs.hmacHex(key, PinProofs.overrideMessage("cash_drop", "op-1", "s", "500000", "p")))
    }

    @Test fun theVerifierIsTheHashOfTheKeyAndAWrongPinDoesNotMatch() {
        val salt = "abcdef0123456789abcdef0123456789"
        val hash = verifier("654321", salt)
        assertTrue(PinProofs.matches(PinProofs.derive("654321", salt, 1000), hash))
        assertFalse(PinProofs.matches(PinProofs.derive("654322", salt, 1000), hash))
    }

    @Test fun aPinThatIsNotSixToTwelveDigitsIsRefusedWithoutDoingTheWork() {
        assertNull(PinProofs.signIfValid("12345", "salt", "00", "m"))
        assertNull(PinProofs.signIfValid("12345a", "salt", "00", "m"))
        assertNull(PinProofs.signIfValid("1234567890123", "salt", "00", "m"))
    }

    @Test fun fiveWrongPinsLockThatPersonForTenMinutesAndOnlyThem() {
        var now = 1_000_000L
        val lock = PinLockout(MemoryStorage(), { now })
        repeat(4) { assertFalse(lock.recordFailure("sup-1")); now += 1000 }
        assertEquals(1, lock.triesLeft("sup-1"))
        assertTrue(lock.recordFailure("sup-1"))
        assertTrue(lock.lockedForMs("sup-1") > 9 * 60_000L)
        assertEquals(0L, lock.lockedForMs("sup-2"))
        now += 5 * 60_000L
        assertTrue(lock.lockedForMs("sup-1") in 1..(5 * 60_000L))
        now += 6 * 60_000L
        assertEquals(0L, lock.lockedForMs("sup-1"))
    }

    @Test fun failuresOutsideTheWindowDoNotCountAndASuccessClearsThem() {
        var now = 0L
        val lock = PinLockout(MemoryStorage(), { now })
        repeat(4) { lock.recordFailure("a"); now += 1000 }
        now += 11 * 60_000L
        assertFalse(lock.recordFailure("a")); assertEquals(4, lock.triesLeft("a"))
        lock.reset("a"); assertEquals(5, lock.triesLeft("a"))
        assertEquals("10 minutes", PinLockout.words(10 * 60_000L)); assertEquals("1 minute", PinLockout.words(20_000L))
    }
}
