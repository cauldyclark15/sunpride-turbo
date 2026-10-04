package com.sunpride.field.evidence

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Photo bytes at rest, addressed by the photo's local ID. */
interface PhotoFiles {
    /** Durable before return: a crash afterwards leaves a complete file, never a partial one. */
    fun write(localId: String, bytes: ByteArray)
    fun read(localId: String): ByteArray
    fun delete(localId: String)
}

/**
 * AND-016: each JPEG is sealed with AES-256-GCM under a non-exportable Android Keystore key and
 * kept in no-backup app storage, so a backup, a copied file or another app never sees a store
 * photo. The local ID is bound as associated data: one photo's file cannot be swapped for another's.
 */
class KeystorePhotoFiles(context: Context, private val alias: String = ALIAS) : PhotoFiles {
    private val directory = File(context.applicationContext.noBackupFilesDir, "evidence").apply { mkdirs() }
    private val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    @Synchronized private fun key(): SecretKey {
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
    private fun file(localId: String): File {
        require(localId.matches(Regex("^[0-9a-f-]{36}$"))) { "Invalid photo ID" }
        return File(directory, "$localId.jpg.enc")
    }
    private fun aad(localId: String) = "sunpride.field.evidence.v1|$localId".toByteArray(Charsets.UTF_8)

    override fun write(localId: String, bytes: ByteArray) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(aad(localId))
        val sealed = cipher.iv + cipher.doFinal(bytes)
        val target = file(localId)
        val partial = File(directory, target.name + ".part")
        partial.outputStream().use { out -> out.write(sealed); out.fd.sync() }
        check(partial.renameTo(target)) { "Could not save photo" }
    }
    override fun read(localId: String): ByteArray {
        val sealed = file(localId).readBytes()
        require(sealed.size > 12 + 16) { "Damaged photo" }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, sealed, 0, 12))
        cipher.updateAAD(aad(localId))
        return cipher.doFinal(sealed, 12, sealed.size - 12)
    }
    override fun delete(localId: String) { file(localId).delete() }
    /** Test/diagnostic seam: the raw sealed bytes as stored on disk. */
    internal fun sealed(localId: String): ByteArray = file(localId).readBytes()

    companion object { const val ALIAS = "sunpride-field-evidence-aes-v1" }
}
