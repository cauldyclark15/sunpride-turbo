package com.sunpride.chat

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.FileProvider
import java.io.File

/** What may be attached, in the words the server uses (contract: "Attachments"). Pure, so unit-tested. */
object AttachmentRules {
    const val MAX_FILE_BYTES = 25L * 1024 * 1024
    const val MAX_THUMB_BYTES = 1L * 1024 * 1024
    const val THUMB_MAX_PX = 320
    const val MAX_PER_MESSAGE = 10

    val IMAGE_MIMES = listOf("image/jpeg", "image/png", "image/webp", "image/gif")
    val DOCUMENT_MIMES = listOf(
        "application/pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "text/csv", "text/plain", "application/zip",
    )
    val ALL = IMAGE_MIMES + DOCUMENT_MIMES
    /** For ACTION_OPEN_DOCUMENT. */
    val OPEN_DOCUMENT_TYPES: Array<String> get() = ALL.toTypedArray()

    private val byExtension = mapOf("jpg" to "image/jpeg", "jpeg" to "image/jpeg", "png" to "image/png", "webp" to "image/webp",
        "gif" to "image/gif", "pdf" to "application/pdf", "csv" to "text/csv", "txt" to "text/plain", "zip" to "application/zip",
        "docx" to DOCUMENT_MIMES[1], "xlsx" to DOCUMENT_MIMES[2], "pptx" to DOCUMENT_MIMES[3])

    /** Phones report odd types (`text/comma-separated-values`, `application/octet-stream`): trust the file name when needed. */
    fun normalize(reported: String?, name: String): String? {
        val r = reported?.lowercase()?.substringBefore(';')?.trim()
        val fromName = byExtension[name.substringAfterLast('.', "").lowercase()]
        return when {
            r in ALL -> r
            r == "text/comma-separated-values" || r == "application/csv" -> "text/csv"
            r == "image/jpg" -> "image/jpeg"
            r.isNullOrEmpty() || r == "application/octet-stream" || r == "application/x-zip-compressed" -> fromName
            else -> fromName?.takeIf { r?.startsWith("text/") == true || r?.startsWith("application/") == true }
        }
    }

    /** Null when fine, otherwise a sentence for the person. */
    fun problem(name: String, mime: String?, bytes: Long): String? = when {
        mime == null || mime !in ALL -> "\"$name\" can't be sent. Photos, PDF, Word, Excel, PowerPoint, CSV, text and zip files are allowed."
        bytes <= 0 -> "\"$name\" is empty."
        bytes > MAX_FILE_BYTES -> "\"$name\" is too big. The limit is 25 MB per file."
        else -> null
    }

    /** Largest size with the same shape whose longest side is at most [max]; never enlarges. */
    fun fit(width: Int, height: Int, max: Int = THUMB_MAX_PX): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return 0 to 0
        val longest = maxOf(width, height)
        if (longest <= max) return width to height
        val scale = max.toDouble() / longest
        return maxOf(1, Math.round(width * scale).toInt()) to maxOf(1, Math.round(height * scale).toInt())
    }
}

/** Copies a picked or captured file into app storage (so it survives a restart) and makes the client JPEG thumbnail. */
object AttachmentPrep {
    class Rejected(message: String) : Exception(message)

    fun fromUri(context: Context, uri: Uri, destDir: File, fallbackName: String = "file"): LocalAttachment {
        val resolver = context.contentResolver
        var name = fallbackName
        var size = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
            if (c.moveToFirst()) {
                c.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { c.getString(it)?.let { n -> name = n } }
                c.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !c.isNull(it) }?.let { size = c.getLong(it) }
            }
        }
        name = name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").take(120).ifBlank { fallbackName }
        val mime = AttachmentRules.normalize(resolver.getType(uri), name)
        if (size > AttachmentRules.MAX_FILE_BYTES) throw Rejected(AttachmentRules.problem(name, mime, size)!!)
        destDir.mkdirs()
        val dest = File(destDir, java.util.UUID.randomUUID().toString().take(8) + "-" + name)
        resolver.openInputStream(uri)?.use { input ->
            dest.outputStream().use { out ->
                val buf = ByteArray(64 * 1024); var total = 0L
                while (true) {
                    val n = input.read(buf); if (n < 0) break
                    total += n
                    if (total > AttachmentRules.MAX_FILE_BYTES) { dest.delete(); throw Rejected(AttachmentRules.problem(name, mime, total)!!) }
                    out.write(buf, 0, n)
                }
            }
        } ?: throw Rejected("\"$name\" couldn't be opened.")
        return fromFile(dest, name, mime)
    }

    fun fromFile(file: File, name: String, reportedMime: String?): LocalAttachment {
        val mime = AttachmentRules.normalize(reportedMime, name)
        AttachmentRules.problem(name, mime, file.length())?.let { file.delete(); throw Rejected(it) }
        val sha = Hashes.sha256Hex(file)
        if (mime!!.startsWith("image/")) {
            val thumb = File(file.parentFile, file.nameWithoutExtension + "-thumb.jpg")
            val dims = Thumbnails.create(file, thumb)
            return LocalAttachment(file.path, name, mime, file.length(), sha, dims?.first, dims?.second, if (dims != null) thumb.path else null)
        }
        return LocalAttachment(file.path, name, mime, file.length(), sha)
    }
}

object Thumbnails {
    /** Writes a JPEG no bigger than 320 px on its longest side and under 1 MB. Returns the original (upright) size. */
    fun create(src: File, dest: File): Pair<Int, Int>? = try {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(src.path, bounds)
        if (bounds.outWidth <= 0) null else {
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= AttachmentRules.THUMB_MAX_PX * 2 && bounds.outHeight / (sample * 2) >= AttachmentRules.THUMB_MAX_PX * 2) sample *= 2
            val decoded = BitmapFactory.decodeFile(src.path, BitmapFactory.Options().apply { inSampleSize = sample })
            if (decoded == null) null else {
                val turn = when (runCatching { ExifInterface(src.path).getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) }.getOrDefault(1)) {
                    ExifInterface.ORIENTATION_ROTATE_90 -> 90f; ExifInterface.ORIENTATION_ROTATE_180 -> 180f; ExifInterface.ORIENTATION_ROTATE_270 -> 270f; else -> 0f
                }
                val upright = if (turn == 0f) decoded else Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, Matrix().apply { postRotate(turn) }, true)
                val (w, h) = AttachmentRules.fit(upright.width, upright.height)
                val scaled = Bitmap.createScaledBitmap(upright, w, h, true)
                // JPEG has no transparency: put PNG/GIF/WebP art on white.
                val flat = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { Canvas(it).apply { drawColor(Color.WHITE); drawBitmap(scaled, 0f, 0f, null) } }
                var quality = 82
                do {
                    dest.outputStream().use { flat.compress(Bitmap.CompressFormat.JPEG, quality, it) }
                    quality -= 15
                } while (dest.length() > AttachmentRules.MAX_THUMB_BYTES && quality > 20)
                // report the full-size dimensions (upright), not the thumbnail's
                val full = if (turn == 90f || turn == 270f) bounds.outHeight to bounds.outWidth else bounds.outWidth to bounds.outHeight
                full
            }
        }
    } catch (_: Exception) { null }
}

/** Opens a received file with whatever app the phone has for it, through a FileProvider (never a file:// path). */
object FileOpener {
    fun authority(context: Context) = context.packageName + ".chat"

    /** Blocking (downloads the file first). Returns an error sentence, or null when an app was started. */
    fun open(context: Context, api: ChatApi, a: Attachment): String? {
        val dir = File(context.cacheDir, "chat-files/" + a.id.replace(Regex("[^A-Za-z0-9_-]"), "_")).apply { mkdirs() }
        val file = File(dir, a.name.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), "_").ifBlank { "file" })
        try {
            if (!file.exists() || file.length() == 0L) file.writeBytes(api.download(a.url, AttachmentRules.MAX_FILE_BYTES + 1024))
        } catch (e: ChatException) { file.delete(); return ChatErrors.words(e) }
        val uri = FileProvider.getUriForFile(context, authority(context), file)
        val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, a.mime)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        return try { context.startActivity(intent); null }
        catch (_: ActivityNotFoundException) { "No app on this phone can open ${a.name}." }
    }
}
