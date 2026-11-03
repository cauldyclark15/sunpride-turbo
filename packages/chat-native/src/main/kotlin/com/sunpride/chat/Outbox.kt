package com.sunpride.chat

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** A file picked for a message, already copied into app storage so it survives a restart. */
data class LocalAttachment(
    val path: String, val name: String, val mime: String, val bytes: Long, val sha256: String,
    val width: Int? = null, val height: Int? = null, val thumbPath: String? = null,
    /** Set once the file itself has been uploaded; a retry then never uploads it twice. */
    val attachmentId: String? = null, val thumbDone: Boolean = false,
) {
    val isImage get() = mime.startsWith("image/")
    fun toJson(): JSONObject = JSONObject().put("path", path).put("name", name).put("mime", mime).put("bytes", bytes).put("sha256", sha256)
        .putNullable("width", width).putNullable("height", height).putNullable("thumb_path", thumbPath)
        .putNullable("attachment_id", attachmentId).put("thumb_done", thumbDone)
    companion object {
        fun from(o: JSONObject) = LocalAttachment(o.getString("path"), o.str("name") ?: "File", o.str("mime") ?: "application/octet-stream",
            o.optLong("bytes", 0), o.str("sha256") ?: "", o.int("width"), o.int("height"), o.str("thumb_path"), o.str("attachment_id"),
            o.optBoolean("thumb_done", false))
    }
}

enum class PendingState { WAITING, FAILED }

/** One message the person sent that the server has not confirmed. Keyed by [clientMsgId], which is the replay key. */
data class PendingSend(
    val clientMsgId: String, val conversationId: String, val body: String, val parentMessageId: String?,
    val attachments: List<LocalAttachment>, val createdAtMs: Long, val order: Long,
    val attempts: Int = 0, val nextAttemptAtMs: Long = 0, val state: PendingState = PendingState.WAITING, val failure: String? = null,
) {
    fun toJson(): JSONObject = JSONObject().put("client_msg_id", clientMsgId).put("conversation_id", conversationId).put("body", body)
        .putNullable("parent_message_id", parentMessageId).put("attachments", JSONArray(attachments.map { it.toJson() }))
        .put("created_at_ms", createdAtMs).put("order", order).put("attempts", attempts).put("next_attempt_at_ms", nextAttemptAtMs)
        .put("state", state.name).putNullable("failure", failure)
    companion object {
        fun from(o: JSONObject) = PendingSend(o.getString("client_msg_id"), o.getString("conversation_id"), o.str("body") ?: "",
            o.str("parent_message_id"), o.arr("attachments").mapObjects(LocalAttachment::from), o.optLong("created_at_ms", 0),
            o.optLong("order", 0), o.optInt("attempts", 0), o.optLong("next_attempt_at_ms", 0),
            runCatching { PendingState.valueOf(o.optString("state")) }.getOrDefault(PendingState.WAITING), o.str("failure"))
    }
}

interface OutboxStore {
    fun load(): List<PendingSend>
    fun save(items: List<PendingSend>)
}
class MemoryOutboxStore : OutboxStore {
    private var items: List<PendingSend> = emptyList()
    override fun load() = items
    override fun save(items: List<PendingSend>) { this.items = items }
}
/** `outbox.json`, replaced atomically on every change so a crash never loses or half-writes a pending send. */
class FileOutboxStore(private val file: File) : OutboxStore {
    override fun load(): List<PendingSend> = runCatching {
        if (!file.exists()) emptyList() else JSONArray(file.readText()).mapObjects(PendingSend::from)
    }.getOrDefault(emptyList())
    override fun save(items: List<PendingSend>) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, file.name + ".tmp")
        tmp.writeText(JSONArray(items.map { it.toJson() }).toString())
        if (!tmp.renameTo(file)) { file.delete(); tmp.renameTo(file) }
    }
}

object Backoff {
    const val BASE_MS = 2_000L
    const val MAX_MS = 5 * 60_000L
    /** attempt 1 → 2 s, 2 → 4 s, … capped at 5 minutes. */
    fun delayMs(attempt: Int): Long = if (attempt <= 0) 0 else minOf(MAX_MS, BASE_MS shl minOf(attempt - 1, 16))
}

data class FlushResult(val sent: List<Pair<PendingSend, ChatMessage>>, val failed: List<PendingSend>, val stillWaiting: Int, val sessionExpired: Boolean)

/**
 * Pending sends, oldest first. Rules:
 * - a conversation's sends go in order: if one is waiting for its retry time or just failed to reach the server,
 *   later ones in the same conversation wait behind it;
 * - a refusal about the content (4xx other than 429) marks only that send FAILED and does not block the rest;
 * - re-sending the same client_msg_id is safe (the server returns the original), so a crash between "sent" and
 *   "saved" never creates a duplicate.
 */
class Outbox(
    private val store: OutboxStore,
    private val api: ChatApi,
    private val clock: () -> Long = System::currentTimeMillis,
    private val readBytes: (String) -> ByteArray = { File(it).readBytes() },
    private val deleteFile: (String) -> Unit = { File(it).delete() },
    private val maxAgeMs: Long = 7L * 24 * 3600 * 1000,
) {
    private val lock = Any()
    private var items: MutableList<PendingSend> = store.load().toMutableList()
    private var counter: Long = (items.maxOfOrNull { it.order } ?: 0L)

    fun list(): List<PendingSend> = synchronized(lock) { items.sortedBy { it.order } }
    fun forConversation(id: String): List<PendingSend> = list().filter { it.conversationId == id }

    fun enqueue(conversationId: String, body: String, parentId: String?, attachments: List<LocalAttachment>,
        clientMsgId: String = java.util.UUID.randomUUID().toString()): PendingSend = synchronized(lock) {
        val p = PendingSend(clientMsgId, conversationId, body, parentId, attachments, clock(), ++counter)
        if (items.none { it.clientMsgId == clientMsgId }) { items.add(p); persist() }
        p
    }

    /** Give up on a send (the person pressed Discard). */
    fun discard(clientMsgId: String) = synchronized(lock) {
        items.firstOrNull { it.clientMsgId == clientMsgId }?.let { cleanup(it); items.remove(it); persist() }
        Unit
    }

    /** The person pressed Try again. */
    fun retryNow(clientMsgId: String) = synchronized(lock) {
        replace(clientMsgId) { it.copy(state = PendingState.WAITING, nextAttemptAtMs = 0, failure = null) }
    }

    /** When [force] is true (the phone just came back online, or the person tapped Try again) retry times are ignored. */
    fun flush(force: Boolean = false): FlushResult {
        val sent = ArrayList<Pair<PendingSend, ChatMessage>>()
        val failed = ArrayList<PendingSend>()
        val blocked = HashSet<String>()
        var expired = false
        for (snapshot in list()) {
            if (expired) break
            val p = current(snapshot.clientMsgId) ?: continue
            if (p.state == PendingState.FAILED) continue
            if (p.conversationId in blocked) continue
            val now = clock()
            if (now - p.createdAtMs > maxAgeMs) { failed.add(markFailed(p, "This message could not be sent in time.")); continue }
            if (!force && p.nextAttemptAtMs > now) { blocked.add(p.conversationId); continue }
            try {
                val message = deliver(p)
                synchronized(lock) { items.removeAll { it.clientMsgId == p.clientMsgId }; persist() }
                cleanup(p)
                sent.add(p to message)
            } catch (e: ChatException) {
                when {
                    e is ChatException.SessionExpired -> { expired = true; bump(p, now) }
                    e.retryable -> { bump(p, now); blocked.add(p.conversationId) }
                    else -> failed.add(markFailed(p, ChatErrors.words(e)))
                }
            }
        }
        val waiting = synchronized(lock) { items.count { it.state == PendingState.WAITING } }
        return FlushResult(sent, failed, waiting, expired)
    }

    private fun deliver(start: PendingSend): ChatMessage {
        var p = start
        val ids = ArrayList<String>()
        for ((index, a0) in p.attachments.withIndex()) {
            var a = a0
            if (a.attachmentId == null) {
                val claim = api.claim(a.name, a.mime, a.bytes, a.sha256, "file", null)
                api.upload(claim.uploadUrl, readBytes(a.path), a.mime)
                a = a.copy(attachmentId = claim.attachmentId)
                p = withAttachment(p, index, a)
            }
            if (a.thumbPath != null && !a.thumbDone) {
                val bytes = readBytes(a.thumbPath)
                val claim = api.claim(a.name.substringBeforeLast('.') + "-thumb.jpg", "image/jpeg", bytes.size.toLong(), Hashes.sha256Hex(bytes), "thumb", a.attachmentId)
                api.upload(claim.uploadUrl, bytes, "image/jpeg")
                a = a.copy(thumbDone = true)
                p = withAttachment(p, index, a)
            }
            ids.add(checkNotNull(a.attachmentId))
        }
        return api.sendMessage(p.conversationId, p.clientMsgId, p.body, p.parentMessageId, ids).message
    }

    private fun withAttachment(p: PendingSend, index: Int, a: LocalAttachment): PendingSend = synchronized(lock) {
        val next = p.copy(attachments = p.attachments.toMutableList().also { it[index] = a })
        replace(p.clientMsgId) { next }
        next
    }

    private fun current(id: String) = synchronized(lock) { items.firstOrNull { it.clientMsgId == id } }
    private fun bump(p: PendingSend, now: Long) = synchronized(lock) {
        replace(p.clientMsgId) { val n = it.attempts + 1; it.copy(attempts = n, nextAttemptAtMs = now + Backoff.delayMs(n)) }
    }
    private fun markFailed(p: PendingSend, why: String): PendingSend = synchronized(lock) {
        replace(p.clientMsgId) { it.copy(state = PendingState.FAILED, failure = why) }
        items.firstOrNull { it.clientMsgId == p.clientMsgId } ?: p
    }
    private fun replace(id: String, f: (PendingSend) -> PendingSend) {
        val i = items.indexOfFirst { it.clientMsgId == id }
        if (i >= 0) { items[i] = f(items[i]); persist() }
    }
    private fun persist() = store.save(items.toList())
    private fun cleanup(p: PendingSend) = p.attachments.forEach { a -> runCatching { deleteFile(a.path) }; a.thumbPath?.let { runCatching { deleteFile(it) } } }
}

object Hashes {
    fun sha256Hex(bytes: ByteArray): String = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun sha256Hex(file: File): String {
        val md = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { s -> val buf = ByteArray(64 * 1024); while (true) { val n = s.read(buf); if (n < 0) break; md.update(buf, 0, n) } }
        return md.digest().joinToString("") { "%02x".format(it) }
    }
}
