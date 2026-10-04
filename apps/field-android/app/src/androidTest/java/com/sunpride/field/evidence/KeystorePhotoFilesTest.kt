package com.sunpride.field.evidence

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.security.KeyStore
import java.util.UUID

/** AND-016: photos are sealed with a Keystore key in no-backup storage and bound to their own ID. */
@RunWith(AndroidJUnit4::class)
class KeystorePhotoFilesTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val alias = "evidence-files-test"
    private val files = KeystorePhotoFiles(context, alias)
    private val ids = mutableListOf<String>()
    private fun id() = UUID.randomUUID().toString().also { ids += it }
    @After fun cleanup() {
        ids.forEach { files.delete(it) }
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    @Test fun roundTripsSealedBytesWithoutPlaintextOnDisk() {
        val photo = ByteArray(64 * 1024) { (it % 251).toByte() }
        val marker = "SUNPRIDE-SHELF-PHOTO".toByteArray()
        marker.copyInto(photo, 1000)
        val first = id()
        files.write(first, photo)
        assertArrayEquals(photo, files.read(first))
        val sealed = files.sealed(first)
        assertNotEquals(photo.size, sealed.size)
        assertFalse(String(sealed, Charsets.ISO_8859_1).contains(String(marker, Charsets.ISO_8859_1)))
        val stored = File(context.noBackupFilesDir, "evidence/$first.jpg.enc")
        assertTrue(stored.exists())
        assertFalse(File(context.noBackupFilesDir, "evidence/$first.jpg.enc.part").exists())
        // Same bytes, fresh IV: two captures never share ciphertext.
        val second = id()
        files.write(second, photo)
        assertFalse(sealed.contentEquals(files.sealed(second)))
        // A file moved under another photo's ID fails authentication instead of uploading the wrong photo.
        stored.copyTo(File(context.noBackupFilesDir, "evidence/$second.jpg.enc"), overwrite = true)
        assertThrows(Exception::class.java) { files.read(second) }
        files.delete(first)
        assertFalse(stored.exists())
        assertThrows(IllegalArgumentException::class.java) { files.write("../escape", photo) }
    }
}
