package com.sunpride.field.auth

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.core.content.edit
import java.security.KeyStore
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Persistent auth state. The Better Auth session token is the only secret; deviceId is not. */
interface SessionVault {
    fun readSession(): String?
    fun saveSession(token: String)
    var deviceId: String?
    /** Sign-out wipe: session and cached deviceId. The device key itself is kept (it is registered). */
    fun wipe()
}

/**
 * Session token encrypted with a non-exportable AES-256-GCM key in AndroidKeyStore; only IV and
 * ciphertext reach SharedPreferences. The manifest sets `allowBackup=false` and backup/data-extraction
 * rules exclude this file anyway. A token that no longer decrypts (key invalidated, data restored onto
 * another device) is treated as signed out and wiped.
 */
class KeystoreSessionVault(
    context: Context,
    private val prefsName: String = PREFS,
    private val alias: String = KEY_ALIAS
) : SessionVault {
    private val prefs = context.applicationContext.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey {
        (keyStore.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    @Synchronized override fun saveSession(token: String) {
        require(token.isNotBlank())
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key()) // Keystore generates the random 12-byte IV
        cipher.updateAAD(AAD)
        val sealed = cipher.iv + cipher.doFinal(token.toByteArray(Charsets.UTF_8))
        prefs.edit(commit = true) { putString(SESSION, Base64.getEncoder().encodeToString(sealed)) }
    }

    @Synchronized override fun readSession(): String? {
        val stored = prefs.getString(SESSION, null) ?: return null
        return try {
            val sealed = Base64.getDecoder().decode(stored)
            require(sealed.size > IV_BYTES + TAG_BYTES)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BYTES * 8, sealed, 0, IV_BYTES))
            cipher.updateAAD(AAD)
            String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
        } catch (_: Exception) {
            wipe()
            null
        }
    }

    /** Raw stored value, for tests proving the token is not persisted in plaintext. */
    internal fun rawStoredValue(): String? = prefs.getString(SESSION, null)

    override var deviceId: String?
        get() = prefs.getString(DEVICE_ID, null)
        set(value) { prefs.edit(commit = true) { if (value == null) remove(DEVICE_ID) else putString(DEVICE_ID, value) } }

    @Synchronized override fun wipe() {
        prefs.edit(commit = true) { remove(SESSION); remove(DEVICE_ID) }
    }

    companion object {
        const val PREFS = "field_secure_session"
        const val KEY_ALIAS = "sunpride-field-session-aes-v1"
        private const val SESSION = "session.v1"
        private const val DEVICE_ID = "deviceId"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BYTES = 16
        private val AAD = "sunpride.field.session.v1".toByteArray(Charsets.UTF_8)
    }
}

/** Process-memory vault for JVM tests and previews. */
class InMemorySessionVault : SessionVault {
    @Volatile private var session: String? = null
    override fun readSession(): String? = session
    override fun saveSession(token: String) { session = token }
    @Volatile override var deviceId: String? = null
    override fun wipe() { session = null; deviceId = null }
}
