package com.sunpride.field.device

import java.math.BigInteger
import java.security.MessageDigest
import java.util.Base64

/** Malformed signature material. The message never contains key, proof or signed-string bytes. */
class InvalidSignatureEncoding(reason: String) : IllegalArgumentException(reason)

/**
 * JCA `SHA256withECDSA` emits ASN.1 DER `SEQUENCE { INTEGER r, INTEGER s }`; the Convex verifier
 * (WebCrypto) accepts only IEEE P1363 `r || s`, each left-padded to 32 bytes. Parsing is strict:
 * short-form lengths only, positive minimal INTEGERs, 1 <= r,s < n, no trailing bytes.
 */
object EcdsaEncoding {
    const val SCALAR_BYTES = 32
    /** Order n of the P-256 group. */
    val P256_ORDER = BigInteger("FFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551", 16)

    fun derToP1363(der: ByteArray): ByteArray {
        var pos = 0
        fun octet(): Int {
            if (pos >= der.size) throw InvalidSignatureEncoding("Truncated DER")
            return der[pos++].toInt() and 0xff
        }
        if (octet() != 0x30) throw InvalidSignatureEncoding("Expected DER sequence")
        val length = octet()
        // P-256 signatures are at most 72 bytes, so long-form lengths are never valid here.
        if (length >= 0x80 || length != der.size - pos) throw InvalidSignatureEncoding("Invalid sequence length")
        fun scalar(): ByteArray {
            if (octet() != 0x02) throw InvalidSignatureEncoding("Expected DER integer")
            val size = octet()
            if (size !in 1..SCALAR_BYTES + 1 || pos + size > der.size) throw InvalidSignatureEncoding("Invalid integer length")
            val bytes = der.copyOfRange(pos, pos + size)
            pos += size
            if (bytes[0].toInt() and 0x80 != 0) throw InvalidSignatureEncoding("Negative integer")
            if (size > 1 && bytes[0].toInt() == 0 && bytes[1].toInt() and 0x80 == 0)
                throw InvalidSignatureEncoding("Non-minimal integer")
            val unsigned = if (bytes[0].toInt() == 0 && size > 1) bytes.copyOfRange(1, size) else bytes
            if (unsigned.size > SCALAR_BYTES) throw InvalidSignatureEncoding("Integer too large")
            val value = BigInteger(1, unsigned)
            if (value.signum() == 0 || value >= P256_ORDER) throw InvalidSignatureEncoding("Integer out of range")
            return ByteArray(SCALAR_BYTES - unsigned.size) + unsigned
        }
        val r = scalar()
        val s = scalar()
        if (pos != der.size) throw InvalidSignatureEncoding("Trailing DER bytes")
        return r + s
    }

    /** Inverse conversion (minimal DER), used to verify P1363 proofs with JCA. */
    fun p1363ToDer(raw: ByteArray): ByteArray {
        if (raw.size != 2 * SCALAR_BYTES) throw InvalidSignatureEncoding("P1363 signature must be 64 bytes")
        fun integer(half: ByteArray): ByteArray {
            val value = BigInteger(1, half)
            if (value.signum() == 0 || value >= P256_ORDER) throw InvalidSignatureEncoding("Integer out of range")
            val minimal = value.toByteArray() // two's complement: adds the 0x00 sign pad when needed
            return byteArrayOf(0x02, minimal.size.toByte()) + minimal
        }
        val body = integer(raw.copyOfRange(0, SCALAR_BYTES)) + integer(raw.copyOfRange(SCALAR_BYTES, raw.size))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }
}

fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
fun unbase64(text: String): ByteArray = Base64.getDecoder().decode(text)
fun sha256(bytes: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(bytes)
fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

/** Short human-comparable fingerprint of the SPKI bytes, e.g. `3f2a 91c0 7b1e 55d4`. */
fun fingerprint(spki: ByteArray): String = hex(sha256(spki)).take(16).chunked(4).joinToString(" ")
