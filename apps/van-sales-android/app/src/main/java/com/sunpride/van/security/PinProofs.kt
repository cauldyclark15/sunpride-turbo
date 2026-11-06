package com.sunpride.van.security

import java.security.MessageDigest
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * IP-HH2: the per-person PIN checks the server expects from the phone (store supervisors, van crew). A PIN never leaves the phone and is
 * never stored: it is turned into a 32-byte key with PBKDF2-SHA256 (160,000 rounds, the office's salt), checked against the downloaded
 * verifier (`sha256(key)`), and then used to sign ONE action (HMAC-SHA256 over a message naming the action, its amount and the PIN version),
 * so a proof cannot be replayed for another sale, amount or day.
 */
object PinProofs {
    const val ROUNDS = 160_000
    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }

    /** The key for [pin] and the office's [salt] (the salt text's own bytes, as the server does). The caller wipes it. */
    fun derive(pin: String, salt: String, rounds: Int = ROUNDS): ByteArray {
        val chars = pin.toCharArray()
        val spec = PBEKeySpec(chars, salt.toByteArray(Charsets.UTF_8), rounds, 256)
        return try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded } finally { chars.fill('\u0000'); spec.clearPassword() }
    }

    /** True when [key] is the key behind the downloaded verifier [hashHex]. */
    fun matches(key: ByteArray, hashHex: String): Boolean =
        MessageDigest.isEqual(hex(MessageDigest.getInstance("SHA-256").digest(key)).toByteArray(), hashHex.lowercase().toByteArray())

    fun hmacHex(key: ByteArray, message: String): String {
        val mac = Mac.getInstance("HmacSHA256"); mac.init(SecretKeySpec(key, "HmacSHA256"))
        return hex(mac.doFinal(message.toByteArray(Charsets.UTF_8)))
    }

    /** The text a supervisor signs at the till; [refId] is the op's own id (cash, Z) or the sale id (void, refund, reprint). */
    fun overrideMessage(kind: String, refId: String, shiftId: String?, amountCentavos: String?, pinId: String) =
        "override|$kind|$refId|${shiftId ?: ""}|${amountCentavos ?: "0"}|$pinId"

    /** The text a crew member signs to take over the phone. [at] is the op's own time. */
    fun crewMessage(deviceId: String, tripId: String, toProfileId: String, pinId: String, at: Long) =
        "crew|$deviceId|$tripId|$toProfileId|$pinId|$at"

    /** Checks the PIN against the verifier and signs [message]; null = wrong PIN. The key is wiped before returning. */
    fun signIfValid(pin: String, salt: String, hashHex: String, message: String): String? {
        if (!pin.matches(Regex("[0-9]{6,12}"))) return null
        val key = derive(pin, salt)
        return try { if (matches(key, hashHex)) hmacHex(key, message) else null } finally { key.fill(0) }
    }
}

/** Where wrong-PIN times are kept (Android: SharedPreferences, so closing the app does not reset a lockout). */
interface LockoutStorage { fun load(key: String): List<Long>; fun save(key: String, failures: List<Long>) }

/**
 * 5 wrong PINs within 10 minutes lock that person for 10 minutes, on the phone as on the server. The count is per person, so a locked
 * supervisor does not stop another one.
 */
class PinLockout(private val storage: LockoutStorage, private val clock: () -> Long = System::currentTimeMillis,
    private val maxFailures: Int = 5, private val windowMs: Long = 10 * 60_000L, private val lockMs: Long = 10 * 60_000L) {
    private fun recent(key: String): List<Long> { val now = clock(); return storage.load(key).filter { now - it < maxOf(windowMs, lockMs) } }
    /** Milliseconds still locked (0 = not locked). */
    fun lockedForMs(key: String): Long {
        val failures = recent(key)
        val inWindow = failures.filter { clock() - it < windowMs }
        if (inWindow.size < maxFailures) return 0L
        return maxOf(0L, inWindow.max() + lockMs - clock())
    }
    /** Records one wrong PIN; returns true when it just locked the person. */
    fun recordFailure(key: String): Boolean {
        val now = clock(); storage.save(key, recent(key) + now)
        return lockedForMs(key) > 0
    }
    fun reset(key: String) = storage.save(key, emptyList())
    fun triesLeft(key: String): Int = maxOf(0, maxFailures - recent(key).count { clock() - it < windowMs })
    companion object {
        fun words(ms: Long): String { val min = (ms + 59_999) / 60_000; return if (min <= 1) "1 minute" else "$min minutes" }
    }
}
