package com.sunpride.field.device

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class RequestSignerTest {
    private val signer = JcaDeviceSigner(CryptoVectors.privateKey, CryptoVectors.publicKey, KeyProtection.SOFTWARE)

    @Test fun signerPublicKeyIsTheFrozenSpki() {
        assertEquals(CryptoVectors.json.getString("publicKeySpkiBase64"), signer.publicKeyBase64)
    }

    @Test fun canonicalAndDigestMatchEveryVector() {
        CryptoVectors.vectors.forEach { v ->
            val body = v.getString("bodyUtf8").toByteArray(Charsets.UTF_8)
            assertEquals(v.getString("bodyDigestHex"), RequestSigner.bodyDigest(body))
            assertEquals(v.getString("canonical"), RequestSigner.canonical(v.getString("method"), v.getString("path"),
                body, v.getString("nonce"), v.getLong("timestamp")))
        }
    }

    @Test fun headersCarryAVerifiableP1363SignatureOverTheCanonicalString() {
        CryptoVectors.vectors.forEach { v ->
            val body = v.getString("bodyUtf8").toByteArray(Charsets.UTF_8)
            val headers = RequestSigner.headers(signer, "test-device", v.getString("path"), body,
                v.getString("nonce"), v.getLong("timestamp"))
            assertEquals("1", headers["x-mobile-contract-version"])
            assertEquals("test-device", headers["x-mobile-device-id"])
            assertEquals("ANDROID", headers["x-mobile-app"])
            assertEquals(v.getString("nonce"), headers["x-mobile-nonce"])
            assertEquals(v.getLong("timestamp").toString(), headers["x-mobile-timestamp"])
            assertEquals(v.getString("bodyDigestHex"), headers["x-mobile-body-digest"])
            val signature = headers.getValue("x-mobile-signature")
            assertEquals(64, unbase64(signature).size)
            assertTrue(CryptoVectors.verifyP1363(CryptoVectors.publicKey,
                v.getString("canonical").toByteArray(Charsets.UTF_8), signature))
        }
    }

    @Test fun tamperedBodyDoesNotVerifyAgainstOriginalSignature() {
        val v = CryptoVectors.vector(CryptoVectors.json.getJSONObject("tampered").getString("sourceVector"))
        val tampered = CryptoVectors.json.getJSONObject("tampered").getString("bodyUtf8").toByteArray(Charsets.UTF_8)
        val canonical = RequestSigner.canonical("POST", v.getString("path"), tampered, v.getString("nonce"), v.getLong("timestamp"))
        assertFalse(canonical == v.getString("canonical"))
        assertFalse(CryptoVectors.verifyP1363(CryptoVectors.publicKey, canonical.toByteArray(), v.getString("signatureP1363Base64")))
    }

    @Test fun rejectsUnknownPathAndBadNonce() {
        assertThrows(IllegalArgumentException::class.java) {
            RequestSigner.headers(signer, "d", "/mobile/v1/other", byteArrayOf(), "10000000-0000-4000-8000-000000000001", 1)
        }
        assertThrows(IllegalArgumentException::class.java) {
            RequestSigner.headers(signer, "d", "/mobile/v1/pull", byteArrayOf(), "not-a-nonce", 1)
        }
    }

    @Test fun fingerprintIsShortAndStable() {
        val spki = unbase64(CryptoVectors.json.getString("publicKeySpkiBase64"))
        assertTrue(Regex("^[0-9a-f]{4}( [0-9a-f]{4}){3}$").matches(fingerprint(spki)))
        assertEquals(fingerprint(spki), fingerprint(spki.copyOf()))
    }
}
