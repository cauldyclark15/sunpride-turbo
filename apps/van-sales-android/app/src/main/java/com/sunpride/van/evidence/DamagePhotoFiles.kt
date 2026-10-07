package com.sunpride.van.evidence

import com.sunpride.van.data.DamageRules
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.storage.StoreScope
import java.io.File
import java.util.UUID

data class DamagePhoto(val sha256: String, val file: File)
interface DamageEvidence {
    fun read(sha256: String, maxBytes: Int): ByteArray
    fun uploaded(sha256: String): Boolean
    fun markUploaded(sha256: String)
    fun delete(sha256: String)
}
/** App-private noBackup root supplied by the repository, partitioned so another seller cannot reuse a marker. */
class DamagePhotoFiles(noBackupRoot: File, scope: StoreScope) : DamageEvidence {
    val directory = File(noBackupRoot,"damage-photos/"+hex(sha256(("${scope.fullAuthSubject.length}:${scope.fullAuthSubject}${scope.deviceId.length}:${scope.deviceId}").toByteArray())))
    private fun photo(sha: String): File { require(DamageRules.SHA256.matches(sha)); return File(directory,"$sha.jpg") }
    private fun marker(sha: String) = File(directory,photo(sha).nameWithoutExtension+".uploaded")
    fun save(bytes: ByteArray, maxBytes: Int): DamagePhoto {
        require(bytes.size <= maxBytes && maxBytes in 1024..96_000 && isJpeg(bytes))
        val sha = hex(sha256(bytes)); val file = photo(sha)
        check(directory.isDirectory || directory.mkdirs())
        if (!file.exists()) atomicWrite(file,bytes) else require(file.readBytes().contentEquals(bytes))
        return DamagePhoto(sha,file)
    }
    override fun read(sha256: String, maxBytes: Int): ByteArray {
        val file = photo(sha256); require(file.length() in 1L..maxBytes.toLong())
        return file.readBytes().also { require(isJpeg(it) && hex(sha256(it)) == sha256) }
    }
    override fun uploaded(sha256: String): Boolean = marker(sha256).let { it.isFile && it.readText() == sha256 }
    override fun markUploaded(sha256: String) { atomicWrite(marker(sha256),sha256.toByteArray()) }
    override fun delete(sha256: String) {
        val photo = photo(sha256); val marker = marker(sha256)
        // Keep the marker if photo deletion fails so a later ack cleanup can retry.
        check(!photo.exists() || photo.delete())
        check(!marker.exists() || marker.delete())
    }
    private fun atomicWrite(file: File, bytes: ByteArray) {
        val temporary = File(directory,".${UUID.randomUUID()}.tmp")
        try {
            temporary.outputStream().use { it.write(bytes); it.fd.sync() }
            check(temporary.renameTo(file))
        } finally { temporary.delete() }
    }
    companion object {
        /** A complete, bounded baseline JPEG ([BaselineJpeg]); a bare signature is not a photo. */
        fun isJpeg(bytes: ByteArray) = BaselineJpeg.verify(bytes) != null
    }
}
