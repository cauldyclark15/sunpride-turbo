package com.sunpride.van.evidence

import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.storage.StoreScope
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class DamagePhotoFilesTest {
    @get:Rule val temporary = TemporaryFolder(File(System.getenv("TMPDIR") ?: System.getProperty("java.io.tmpdir")))
    private val bytes: ByteArray = java.util.Base64.getDecoder().decode(org.json.JSONObject(javaClass.classLoader!!
        .getResourceAsStream("evidence-request.json")!!.bufferedReader().readText()).getString("dataBase64"))
    @Test fun exactBytesDigestMarkerAndDeletionSurviveReopen() {
        val root = temporary.newFolder(); val scope = StoreScope("issuer|seller","device")
        val photos = DamagePhotoFiles(root,scope); val saved = photos.save(bytes,90_000)
        assertEquals(hex(sha256(bytes)),saved.sha256); assertFalse(photos.uploaded(saved.sha256))
        assertArrayEquals(bytes,photos.read(saved.sha256,90_000)); photos.markUploaded(saved.sha256)
        val reopened = DamagePhotoFiles(root,scope); assertTrue(reopened.uploaded(saved.sha256))
        reopened.delete(saved.sha256); assertFalse(saved.file.exists()); assertFalse(reopened.uploaded(saved.sha256))
    }
    @Test fun anotherSellerOrDeviceCannotReuseEvidenceOrUploadMarker() {
        val root = temporary.newFolder(); val photos = DamagePhotoFiles(root,StoreScope("issuer|seller","device"))
        val saved = photos.save(bytes,90_000); photos.markUploaded(saved.sha256)
        for (scope in listOf(StoreScope("issuer|other","device"),StoreScope("issuer|seller","other"))) {
            val other = DamagePhotoFiles(root,scope); assertFalse(other.uploaded(saved.sha256))
            assertThrows(IllegalArgumentException::class.java) { other.read(saved.sha256,90_000) }
        }
    }
    @Test fun corruptPhotoOversizeAndTraversalAreRefused() {
        val photos = DamagePhotoFiles(temporary.newFolder(),StoreScope("issuer|seller","device")); val saved = photos.save(bytes,90_000)
        saved.file.writeBytes(bytes.copyOf().also { it[2] = 3 })
        assertThrows(IllegalArgumentException::class.java) { photos.read(saved.sha256,90_000) }
        assertThrows(IllegalArgumentException::class.java) { photos.read("../private",90_000) }
        assertThrows(IllegalArgumentException::class.java) { photos.save(ByteArray(90_001),90_000) }
        // A JPEG signature with no picture is not evidence (release check counterexample).
        assertThrows(IllegalArgumentException::class.java) { photos.save(byteArrayOf(0xff.toByte(),0xd8.toByte(),0xff.toByte(),0xd9.toByte()),90_000) }
    }
}
