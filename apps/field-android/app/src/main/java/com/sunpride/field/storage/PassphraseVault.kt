package com.sunpride.field.storage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Independent install key; never wipe on sign-out while unsent outbox exists. */
internal class PassphraseVault(private val context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("field_database_key", Context.MODE_PRIVATE)
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun key(): SecretKey {
        (keyStore.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    /** SQLCipher takes bytes of a passphrase; ASCII hex encodes exactly 32 random bytes. */
    @Synchronized fun passphrase(): ByteArray {
        val stored = prefs.getString("wrapped.v1", null)
        if (stored != null) {
            val sealed = Base64.getDecoder().decode(stored)
            require(sealed.size > 28) { "Database key unavailable" }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
            cipher.updateAAD(AAD)
            return cipher.doFinal(sealed, 12, sealed.size - 12)
        }
        // If a DB exists but its Keystore key/prefs were lost, refuse to generate a different key.
        check(!context.databaseList().contains(DB_NAME)) { "Database key unavailable" }
        val random = ByteArray(32).also(SecureRandom()::nextBytes)
        val encoded = random.joinToString("") { "%02x".format(it.toInt() and 0xff) }.toByteArray(Charsets.US_ASCII)
        random.fill(0)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(AAD)
        val sealed = cipher.iv + cipher.doFinal(encoded)
        check(prefs.edit().putString("wrapped.v1", Base64.getEncoder().encodeToString(sealed)).commit())
        return encoded
    }

    companion object {
        const val DB_NAME = "field_store.db"
        private const val ALIAS = "sunpride-field-database-aes-v1"
        private val AAD = "sunpride.field.database.v1".toByteArray(Charsets.UTF_8)
    }
}
