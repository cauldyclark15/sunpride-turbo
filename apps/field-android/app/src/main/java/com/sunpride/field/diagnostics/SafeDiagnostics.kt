package com.sunpride.field.diagnostics

import android.content.Context
import android.util.Log
import com.sunpride.field.BuildConfig
import java.io.File
import java.util.UUID

/** Defense in depth. Callers must use fixed event codes, never raw network exceptions or payloads. */
object Redactor {
    fun mask(input: String): String {
        if (input.contains('{') || input.contains('[')) return "[request body]"
        var text = input
        text = text.replace(Regex("(?i)\\bBearer\\s+[^\\s,;]+"), "Bearer [redacted]")
        text = text.replace(Regex("(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])"), "[token]")
        text = text.replace(Regex("(?i)\\b[\\w.+-]+@[\\w.-]+\\.[a-z]{2,}\\b"), "[email]")
        text = text.replace(Regex("(?<!\\d)\\+63[\\s-]?\\d[\\d\\s-]{7,12}\\d"), "[phone]")
        text = text.replace(Regex("(?i)(lat(?:itude)?|lng|lon(?:gitude)?)\\s*[:=]\\s*[-+]?\\d+(?:\\.\\d+)?"), "$1=[coordinate]")
        text = text.replace(Regex("(?<!\\d)[-+]?\\d{1,3}\\.\\d{4,}\\s*[,/]\\s*[-+]?\\d{1,3}\\.\\d{4,}(?!\\d)"), "[coordinates]")
        text = text.replace(Regex("(?i)(signature|sig|name|requestBody|payload)\\s*[:=]\\s*[^,;\\n]+"), "$1=[redacted]")
        text = text.replace(Regex("(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/])"), "[encoded data]")
        return text
    }
}

/** Only known codes are admitted. No Throwable, request text or user strings in Logcat. */
object SafeLog {
    private val codes = setOf("sync_started", "sync_retry", "sync_complete", "sync_held", "worker_stopped", "crash")
    fun event(code: String) {
        if (BuildConfig.DEBUG && code in codes) Log.i("SunprideField", Redactor.mask(code))
    }
    fun event(context: Context, code: String) {
        event(code)
        runCatching { Breadcrumbs(context.noBackupFilesDir).add(code) }
    }
}

/** Private noBackup files: opaque install handle, bounded crash breadcrumbs without a third-party SDK. */
class Breadcrumbs(private val directory: File) {
    companion object { private val lock = Any() }
    private val file get() = File(directory, "field-breadcrumbs")
    fun add(code: String) = synchronized(lock) {
        val safe = if (code in setOf("sync_started", "sync_retry", "sync_complete", "sync_held", "worker_stopped", "crash")) code else "event_redacted"
        val lines = read().takeLast(49) + Redactor.mask(safe)
        directory.mkdirs()
        val staged = File(directory, "field-breadcrumbs.new")
        staged.writeText(lines.joinToString("\n", postfix = "\n"))
        if (!staged.renameTo(file)) {
            file.writeText(lines.joinToString("\n", postfix = "\n")); staged.delete()
        }
    }
    fun read(): List<String> = synchronized(lock) {
        if (file.exists()) file.readLines().takeLast(50) else emptyList()
    }
}

object CrashBreadcrumbs {
    fun install(context: Context) {
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        if (previous is Handler) return
        Thread.setDefaultUncaughtExceptionHandler(Handler(Breadcrumbs(context.noBackupFilesDir), previous))
    }
    private class Handler(private val breadcrumbs: Breadcrumbs,
                          private val previous: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
        override fun uncaughtException(thread: Thread, error: Throwable) {
            try { breadcrumbs.add("crash") } catch (_: Exception) { /* don't mask the original crash */ }
            previous?.uncaughtException(thread, error)
        }
    }
}

class SupportInfo(context: Context) {
    private val prefs = context.getSharedPreferences("support_handle", Context.MODE_PRIVATE)
    val handle: String get() = synchronized(this) {
        prefs.getString("handle", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("handle", it).commit() }
    }
    fun text(status: com.sunpride.field.ui.syncstatus.SyncStatus): String = Redactor.mask(
        "Sunpride Field ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})\n" +
        "Android ${android.os.Build.VERSION.RELEASE}\nSupport handle: $handle\n" +
        "Queued: ${status.queued}; Sending: ${status.sending}; Needs review: ${status.review}; Held: ${status.held}\n" +
        "Last outcome: ${when (status.health) { "synced", "retry_pending", "held_for_review", "never_synced" -> status.health; else -> "unknown" }}"
    )
}
