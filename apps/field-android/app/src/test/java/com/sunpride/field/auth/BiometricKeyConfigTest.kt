package com.sunpride.field.auth

import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager.Authenticators
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SP-0128 release check: Android exempts keys that accept AUTH_DEVICE_CREDENTIAL from enrollment invalidation,
 * so the session key and its prompt must be strong-biometric only. The phone suite reads the real key's KeyInfo.
 */
class BiometricKeyConfigTest {
    @Test fun keyAcceptsStrongBiometricOnly() {
        assertEquals(KeyProperties.AUTH_BIOMETRIC_STRONG, BiometricKeystore.KEY_AUTH_TYPES)
        assertEquals(0, BiometricKeystore.KEY_AUTH_TYPES and KeyProperties.AUTH_DEVICE_CREDENTIAL)
    }

    @Test fun promptNeverOffersTheScreenLock() {
        assertEquals(Authenticators.BIOMETRIC_STRONG, BiometricKeystore.PROMPT_AUTHENTICATORS)
        assertEquals(0, BiometricKeystore.PROMPT_AUTHENTICATORS and Authenticators.DEVICE_CREDENTIAL)
    }

    @Test fun screenLockKeyFromTheFirstBuildIsRetired() {
        assertNotEquals("sunpride-field-session-bio-v1", BiometricKeystore.ALIAS)
        assertTrue("sunpride-field-session-bio-v1" in BiometricKeystore.RETIRED_ALIASES)
    }
}
