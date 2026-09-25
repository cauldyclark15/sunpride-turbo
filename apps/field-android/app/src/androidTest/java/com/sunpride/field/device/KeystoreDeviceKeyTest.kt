package com.sunpride.field.device

import android.content.pm.PackageManager
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.KeyFactory
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

@RunWith(AndroidJUnit4::class)
class KeystoreDeviceKeyTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "sunpride-field-device-test"

    @After fun cleanUp() = KeystoreDeviceKey.delete(alias)

    @Test fun createsP256KeyThatPersistsAndSignsVerifiableP1363() {
        KeystoreDeviceKey.delete(alias)
        val first = KeystoreDeviceKey.loadOrCreate(context, alias)
        val again = KeystoreDeviceKey.loadOrCreate(context, alias) // simulates activity/process recreation
        assertArrayEquals(first.publicKeySpki, again.publicKeySpki)
        assertEquals(first.protection, again.protection)

        // SPKI is DER SubjectPublicKeyInfo for P-256 (91 bytes, id-ecPublicKey + prime256v1).
        val spki = first.publicKeySpki
        assertEquals(91, spki.size)
        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(spki))
        val message = "BIND|dev|cred|10000000-0000-4000-8000-000000000001|1780000000000"
        repeat(20) {
            val p1363 = unbase64(again.sign(message))
            assertEquals(64, p1363.size)
            val ok = Signature.getInstance("SHA256withECDSA").run {
                initVerify(publicKey); update(message.toByteArray()); verify(EcdsaEncoding.p1363ToDer(p1363))
            }
            assertTrue(ok)
        }
        val strongBox = context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)
        Log.i("KeystoreDeviceKeyTest", "protection=${first.protection} strongBoxFeature=$strongBox") // non-secret
        if (strongBox) assertEquals(KeyProtection.STRONGBOX, first.protection)
    }

    @Test fun privateKeyIsNotExportable() {
        KeystoreDeviceKey.loadOrCreate(context, alias)
        val key = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as PrivateKey
        assertEquals(null, key.encoded)
    }

    @Test fun requestSignerHeadersVerifyWithKeystoreKey() {
        val signer = KeystoreDeviceKey.loadOrCreate(context, alias)
        val body = """{"type":"pull.request","contractVersion":1,"deviceId":"dev","cursor":"c","limit":50}""".toByteArray()
        val headers = RequestSigner.headers(signer, "dev", "/mobile/v1/pull", body, "20000000-0000-4000-8000-000000000002", 1780000000123)
        val canonical = RequestSigner.canonical("POST", "/mobile/v1/pull", body, "20000000-0000-4000-8000-000000000002", 1780000000123)
        val publicKey = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(signer.publicKeySpki))
        val ok = Signature.getInstance("SHA256withECDSA").run {
            initVerify(publicKey); update(canonical.toByteArray())
            verify(EcdsaEncoding.p1363ToDer(unbase64(headers.getValue("x-mobile-signature"))))
        }
        assertTrue(ok)
        assertNotEquals(headers["x-mobile-signature"], RequestSigner.headers(signer, "dev", "/mobile/v1/pull", body,
            "20000000-0000-4000-8000-000000000002", 1780000000123)["x-mobile-signature"]) // ECDSA is randomized
    }
}
