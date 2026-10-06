package com.sunpride.field.auth

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.fragment.app.FragmentActivity
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Biometric-sealed session blob (IV + AES-GCM ciphertext) in private, never-backed-up prefs. */
class PrefsSealedTokenStore(context: Context, prefsName: String = PREFS) : SealedTokenStore {
    private val prefs = context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
    override fun read(): ByteArray? = prefs.getString(SEALED, null)?.let {
        runCatching { Base64.getDecoder().decode(it) }.getOrNull()
    }
    override fun write(blob: ByteArray) {
        prefs.edit(commit = true) { putString(SEALED, Base64.getEncoder().encodeToString(blob)) }
    }
    override fun clear() { prefs.edit(commit = true) { remove(SEALED) } }

    companion object {
        const val PREFS = "field_biometric_session"
        private const val SEALED = "sealed.v1"
    }
}

/** The one session vault the activity and background workers share (same process memory). */
object SessionVaults {
    fun app(context: Context): LockableSessionVault {
        val app = context.applicationContext
        return LockableSessionVault(KeystoreSessionVault(app), PrefsSealedTokenStore(app), SessionMemory.process,
            deleteKey = { BiometricKeystore.deleteAll() })
    }
}

/**
 * AES-256-GCM key that needs a strong biometric (fingerprint/face, never the screen lock) for every use.
 *
 * Biometric-only on purpose: Android exempts keys that also accept AUTH_DEVICE_CREDENTIAL from
 * setInvalidatedByBiometricEnrollment, so a screen-lock fallback would keep the key alive after a new
 * fingerprint is added. The fallback is the password screen instead.
 */
object BiometricKeystore {
    /** v2 = biometric-only. v1 (biometric or screen lock) keys are deleted and their sealed copy fails closed. */
    const val ALIAS = "sunpride-field-session-bio-v2"
    val RETIRED_ALIASES = listOf("sunpride-field-session-bio-v1")
    /** The only authenticator the key and the prompt accept. */
    const val KEY_AUTH_TYPES = KeyProperties.AUTH_BIOMETRIC_STRONG
    const val PROMPT_AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val IV_BYTES = 12
    const val TAG_BYTES = 16
    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    fun existing(alias: String): SecretKey? = keyStore().getKey(alias, null) as? SecretKey

    fun create(alias: String): SecretKey = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
        val spec = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .setUserAuthenticationRequired(true)
            // New fingerprints/faces enrolled (or all removed) permanently invalidate the key.
            .setInvalidatedByBiometricEnrollment(true)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) spec.setUserAuthenticationParameters(0, KEY_AUTH_TYPES)
        RETIRED_ALIASES.forEach(::delete)
        init(spec.build())
        generateKey()
    }

    fun delete(alias: String) { runCatching { keyStore().deleteEntry(alias) } }

    /** Sign-out / turn off: the current key and any retired one. */
    fun deleteAll() { (RETIRED_ALIASES + ALIAS).forEach(::delete) }
}

/**
 * Real BiometricPrompt + [BiometricKeystore]. Construct in the activity's onCreate. The cipher is only
 * usable inside the authenticated CryptoObject, so nothing can open the sealed session without the prompt.
 */
class AndroidBiometricCrypto(
    private val activity: FragmentActivity,
    private val alias: String = BiometricKeystore.ALIAS,
) : BiometricCrypto {
    private var pending: ((CryptoOutcome) -> Unit)? = null
    private var input: ByteArray? = null
    private var encrypting = false

    private val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val done = pending ?: return
                val data = input
                pending = null; input = null
                done(try {
                    val cipher = result.cryptoObject?.cipher ?: error("no cipher")
                    val out = cipher.doFinal(data)
                    CryptoOutcome.Done(if (encrypting) cipher.iv + out else out)
                } catch (_: Exception) { CryptoOutcome.Failed })
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                val done = pending ?: return
                pending = null; input = null
                done(when (errorCode) {
                    BiometricPrompt.ERROR_LOCKOUT, BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> CryptoOutcome.LockedOut
                    BiometricPrompt.ERROR_USER_CANCELED, BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                    BiometricPrompt.ERROR_CANCELED -> CryptoOutcome.Cancelled
                    BiometricPrompt.ERROR_NO_BIOMETRICS -> CryptoOutcome.Invalidated
                    else -> CryptoOutcome.Failed
                })
            }
            // onAuthenticationFailed (one unrecognised finger): the system prompt stays open to retry.
        })

    override fun availability(): BiometricAvailability =
        when (BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)) {
            BiometricManager.BIOMETRIC_SUCCESS -> BiometricAvailability.AVAILABLE
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> BiometricAvailability.NOT_ENROLLED
            else -> BiometricAvailability.UNAVAILABLE
        }

    override fun encrypt(plain: ByteArray, done: (CryptoOutcome) -> Unit) {
        val cipher = try {
            Cipher.getInstance(BiometricKeystore.TRANSFORMATION).apply {
                val key = try { BiometricKeystore.existing(alias) ?: BiometricKeystore.create(alias) }
                    catch (_: Exception) { return done(CryptoOutcome.Failed) }
                try { init(Cipher.ENCRYPT_MODE, key) } catch (_: KeyPermanentlyInvalidatedException) {
                    BiometricKeystore.delete(alias)
                    init(Cipher.ENCRYPT_MODE, BiometricKeystore.create(alias))
                }
            }
        } catch (_: Exception) { return done(CryptoOutcome.Failed) }
        start(cipher, plain, encrypt = true, info(
            "Turn on fingerprint sign-in", "Confirm it's you to sign in faster next time"), done)
    }

    override fun decrypt(sealed: ByteArray, done: (CryptoOutcome) -> Unit) {
        if (sealed.size <= BiometricKeystore.IV_BYTES + BiometricKeystore.TAG_BYTES) return done(CryptoOutcome.Invalidated)
        val key = runCatching { BiometricKeystore.existing(alias) }.getOrNull() ?: return done(CryptoOutcome.Invalidated)
        val cipher = try {
            Cipher.getInstance(BiometricKeystore.TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key,
                    GCMParameterSpec(BiometricKeystore.TAG_BYTES * 8, sealed, 0, BiometricKeystore.IV_BYTES))
            }
        } catch (_: KeyPermanentlyInvalidatedException) { return done(CryptoOutcome.Invalidated) }
        catch (_: Exception) { return done(CryptoOutcome.Failed) }
        start(cipher, sealed.copyOfRange(BiometricKeystore.IV_BYTES, sealed.size), encrypt = false,
            info("Sign in to Sunpride Field", "Use your fingerprint or face"), done)
    }

    override fun deleteKey() {
        BiometricKeystore.delete(alias)
        if (alias == BiometricKeystore.ALIAS) BiometricKeystore.deleteAll()
    }

    /** Test/screenshot seam: dismiss a showing prompt (reported as Cancelled). */
    fun cancel() = prompt.cancelAuthentication()

    private fun info(title: String, subtitle: String) = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title).setSubtitle(subtitle).setConfirmationRequired(false).apply {
            // Biometric only (see BiometricKeystore): the way out is the password screen.
            setAllowedAuthenticators(BiometricKeystore.PROMPT_AUTHENTICATORS).setNegativeButtonText("Use password")
        }.build()

    private fun start(cipher: Cipher, data: ByteArray, encrypt: Boolean, info: BiometricPrompt.PromptInfo,
        done: (CryptoOutcome) -> Unit) {
        pending?.invoke(CryptoOutcome.Cancelled)
        pending = done; input = data; encrypting = encrypt
        try { prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher)) }
        catch (_: Exception) { pending = null; input = null; done(CryptoOutcome.Failed) }
    }
}
