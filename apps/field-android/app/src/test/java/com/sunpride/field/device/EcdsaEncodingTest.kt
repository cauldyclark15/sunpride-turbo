package com.sunpride.field.device

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class EcdsaEncodingTest {
    @Test fun everyFrozenDerVectorConvertsToItsP1363() {
        assertEquals(3, CryptoVectors.vectors.size)
        CryptoVectors.vectors.forEach { v ->
            val p1363 = EcdsaEncoding.derToP1363(unbase64(v.getString("signatureDerBase64")))
            assertEquals(v.getString("name"), 64, p1363.size)
            assertEquals(v.getString("name"), v.getString("signatureP1363Base64"), base64(p1363))
        }
    }

    @Test fun p1363ToDerRoundTripsToTheFrozenMinimalDer() {
        CryptoVectors.vectors.forEach { v ->
            assertEquals(v.getString("name"), v.getString("signatureDerBase64"),
                base64(EcdsaEncoding.p1363ToDer(unbase64(v.getString("signatureP1363Base64")))))
        }
    }

    @Test fun highBitScalarKeepsSignPadInDerAndDropsItInP1363() {
        val der = unbase64(CryptoVectors.vector("high-bit-DER-sign-byte").getString("signatureDerBase64"))
        // SEQUENCE(70) INTEGER(33) 00 E4… : the 0x00 is the DER sign pad for a high-bit r.
        assertEquals(0x21, der[3].toInt())
        assertEquals(0x00, der[4].toInt())
        assertTrue(der[5].toInt() and 0x80 != 0)
        val p1363 = EcdsaEncoding.derToP1363(der)
        assertEquals(0xE4, p1363[0].toInt() and 0xff)
    }

    @Test fun shortScalarIsLeftPaddedTo32Bytes() {
        val der = unbase64(CryptoVectors.vector("short-scalar-DER-leading-zero").getString("signatureDerBase64"))
        // r = 0x0089…: a 31-byte scalar, DER-encoded as 00 89… (sign pad) and P1363 left-padded with 00.
        assertEquals(0x20, der[3].toInt())
        val p1363 = EcdsaEncoding.derToP1363(der)
        assertEquals(0, p1363[0].toInt())
        assertEquals(0x89, p1363[1].toInt() and 0xff)
        assertArrayEquals(der.copyOfRange(5, 4 + 32), p1363.copyOfRange(1, 32))
    }

    @Test fun frozenP1363SignaturesVerifyWithJcaPublicKey() {
        CryptoVectors.vectors.forEach { v ->
            assertTrue(v.getString("name"), CryptoVectors.verifyP1363(CryptoVectors.publicKey,
                v.getString("canonical").toByteArray(Charsets.UTF_8), v.getString("signatureP1363Base64")))
        }
    }

    @Test fun rejectsMalformedDer() {
        val good = unbase64(CryptoVectors.vector("utf8-body").getString("signatureDerBase64"))
        val cases = mapOf(
            "empty" to byteArrayOf(),
            "not a sequence" to good.copyOf().also { it[0] = 0x31 },
            "truncated" to good.copyOf(good.size - 1),
            "trailing byte" to good + byteArrayOf(0),
            "long-form length" to byteArrayOf(0x30, 0x81.toByte(), 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01),
            "wrong inner tag" to byteArrayOf(0x30, 0x06, 0x03, 0x01, 0x01, 0x02, 0x01, 0x01),
            "negative r" to byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x80.toByte(), 0x02, 0x01, 0x01),
            "non-minimal r" to byteArrayOf(0x30, 0x07, 0x02, 0x02, 0x00, 0x01, 0x02, 0x01, 0x01),
            "zero r" to byteArrayOf(0x30, 0x06, 0x02, 0x01, 0x00, 0x02, 0x01, 0x01),
            "zero-length r" to byteArrayOf(0x30, 0x05, 0x02, 0x00, 0x02, 0x01, 0x01),
            "missing s" to byteArrayOf(0x30, 0x03, 0x02, 0x01, 0x01),
            "r too long" to (byteArrayOf(0x30, 0x25, 0x02, 0x22) + ByteArray(34) { 0x7f } + byteArrayOf(0x02, 0x01, 0x01)),
            "33 bytes without sign pad" to (byteArrayOf(0x30, 0x26, 0x02, 0x21, 0x01) + ByteArray(32) { 0x01 } + byteArrayOf(0x02, 0x01, 0x01)),
            "r >= n" to (byteArrayOf(0x30, 0x26, 0x02, 0x21, 0x00) + ByteArray(32) { 0xff.toByte() } + byteArrayOf(0x02, 0x01, 0x01)),
        )
        cases.forEach { (name, der) ->
            assertThrows(name, InvalidSignatureEncoding::class.java) { EcdsaEncoding.derToP1363(der) }
        }
    }

    @Test fun rejectsWrongLengthP1363() {
        assertThrows(InvalidSignatureEncoding::class.java) { EcdsaEncoding.p1363ToDer(ByteArray(63) { 1 }) }
        assertThrows(InvalidSignatureEncoding::class.java) { EcdsaEncoding.p1363ToDer(ByteArray(64)) }
    }

    @Test fun manyFreshJcaSignaturesConvertAndVerify() {
        // ~1/2 of scalars need a DER sign pad and ~1/128 of signatures have a scalar under 32 bytes.
        val signer = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.SOFTWARE)
        var padded = 0
        var short = 0
        repeat(2000) { i ->
            val message = "message-$i"
            val der = signer.signDer(message.toByteArray())
            val rLen = der[3].toInt()
            val sLen = der[5 + rLen].toInt()
            if (rLen == 33 || sLen == 33) padded++
            if (unsignedLen(der, 4, rLen) < 32 || unsignedLen(der, 6 + rLen, sLen) < 32) short++
            val p1363 = EcdsaEncoding.derToP1363(der)
            assertEquals(64, p1363.size)
            assertTrue(CryptoVectors.verifyP1363(CryptoVectors.publicKey, message.toByteArray(), base64(p1363)))
            assertArrayEquals(der, EcdsaEncoding.p1363ToDer(p1363))
        }
        assertTrue("sign-pad path exercised", padded > 0)
        assertTrue("short-scalar path exercised", short > 0)
    }

    private fun unsignedLen(der: ByteArray, offset: Int, length: Int) =
        if (der[offset].toInt() == 0) length - 1 else length
}
