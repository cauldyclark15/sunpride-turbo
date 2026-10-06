package com.sunpride.field.auth

import android.graphics.Bitmap
import androidx.biometric.BiometricManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.sunpride.field.MainActivity
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import javax.crypto.Cipher

/**
 * SP-0128 on real hardware: the session key cannot be used without the system prompt, and the real
 * BiometricPrompt appears (captured to the app's external files dir as `biometric-prompt.png`, then cancelled
 * by the test, never by a finger). Uses a test-only key alias; the person's own setting is untouched.
 */
@RunWith(AndroidJUnit4::class)
class BiometricKeystoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "sunpride-field-session-bio-test"

    @After fun cleanUp() = BiometricKeystore.delete(alias)

    private fun strongBiometricEnrolled() =
        BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    @Test fun keyRefusesToSealWithoutTheSystemPrompt() {
        assumeTrue("needs a fingerprint/face enrolled on the phone", strongBiometricEnrolled())
        val key = BiometricKeystore.create(alias)
        val refused = runCatching {
            Cipher.getInstance(BiometricKeystore.TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
                .doFinal("fake-session".toByteArray())
        }
        assertTrue("authentication-bound key must refuse without a prompt", refused.isFailure)
    }

    @Test fun missingKeyOrDamagedBlobIsReportedAsInvalidated() {
        BiometricKeystore.delete(alias)
        val outcomes = mutableListOf<CryptoOutcome>()
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val crypto = AndroidBiometricCrypto(activity, alias)
                crypto.decrypt(ByteArray(64)) { outcomes += it }
                crypto.decrypt(ByteArray(8)) { outcomes += it }
            }
        }
        assertEquals(listOf(CryptoOutcome.Invalidated, CryptoOutcome.Invalidated), outcomes)
    }

    @Test fun realSystemPromptAppearsAndCancelIsReportedAsCancelled() {
        assumeTrue("needs a fingerprint/face enrolled on the phone", strongBiometricEnrolled())
        val outcome = AtomicReference<CryptoOutcome?>()
        val done = CountDownLatch(1)
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            lateinit var crypto: AndroidBiometricCrypto
            scenario.onActivity { activity ->
                crypto = AndroidBiometricCrypto(activity, alias)
                crypto.encrypt("fake-session".toByteArray()) { outcome.set(it); done.countDown() }
            }
            Thread.sleep(2_500)
            val shot = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()
            context.getExternalFilesDir(null)?.let { dir ->
                File(dir, "biometric-prompt.png").outputStream().use { shot.compress(Bitmap.CompressFormat.PNG, 100, it) }
            }
            shot.recycle()
            scenario.onActivity { crypto.cancel() }
            assertTrue("prompt reported back", done.await(10, TimeUnit.SECONDS))
        }
        assertEquals(CryptoOutcome.Cancelled, outcome.get())
    }
}
