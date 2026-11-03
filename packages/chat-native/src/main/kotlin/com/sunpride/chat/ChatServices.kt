package com.sunpride.chat

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import okhttp3.OkHttpClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Everything a host app hands the module. The app adapter builds it from the app's own auth client. */
class ChatEnvironment(
    val context: Context,
    val session: ChatSession,
    val http: OkHttpClient,
    /** Open a web path such as `/stores/<id>` inside the app if it has a screen for it; false when it has none. */
    val openHref: (String) -> Boolean = { false },
)

/** Per-signed-in-person pieces: network, saved messages, unsent messages and the picture cache. */
class ChatRuntime(val api: ChatApi, val repository: ChatRepository, val images: ChatImages, val filesDir: File) {
    /** Half-written messages, kept while you move between screens (in memory only). */
    val drafts = HashMap<String, ComposerDraft>()
}

object ChatServices {
    @Volatile private var cached: Pair<String, ChatRuntime>? = null

    /**
     * Blocking: call off the main thread. Null when we don't yet know who this is (first launch while offline).
     * If a different person has signed in since last time, the previous person's saved chat and unsent
     * messages are deleted, never shown or sent as the new person.
     */
    @Synchronized fun runtime(env: ChatEnvironment): ChatRuntime? {
        cached?.takeIf { it.first == env.session.origin }?.let { return it.second }
        val base = File(env.context.filesDir, "chat").apply { mkdirs() }
        val meFile = File(base, "me.json")
        val stored = runCatching { JSONObject(meFile.readText()) }.getOrNull()
        val storedIds = stored?.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
        var dirName = stored?.optString("dir")?.takeIf { it.isNotEmpty() }
        val api = ChatApi(env.session, env.http)
        // `GET /unread` `me` is the canonical chat id; the `/api/me` ids stay as the fallback.
        val canonical = runCatching { api.unread().me?.id }.getOrNull()
        val fresh = listOfNotNull(canonical).toSet() + runCatching { api.myIds() }.getOrDefault(emptySet())
        var ids = storedIds
        if (fresh.isNotEmpty()) {
            if (storedIds.isNotEmpty() && storedIds.intersect(fresh).isEmpty()) {
                dirName?.let { File(base, "u/$it").deleteRecursively() }
                dirName = null
                ids = fresh
            } else ids = storedIds + fresh
        }
        if (ids.isEmpty()) return null
        if (dirName == null) dirName = Hashes.sha256Hex((env.session.origin + "|" + ids.sorted().first()).toByteArray()).take(12)
        fun save(newIds: Set<String>) {
            runCatching { meFile.writeText(JSONObject().put("ids", JSONArray(newIds.toList())).put("dir", dirName).toString()) }
            runCatching { UnreadCheck.rememberMe(env.context, newIds) }
        }
        save(ids)
        val user = File(base, "u/$dirName").apply { mkdirs() }
        val outbox = Outbox(FileOutboxStore(File(user, "outbox.json")), api)
        val repo = ChatRepository(api, FileChatCache(File(user, "cache")), outbox, initialMeIds = ids, persistMeIds = ::save)
        val runtime = ChatRuntime(api, repo, ChatImages(api, File(env.context.cacheDir, "chat-images")), File(user, "files").apply { mkdirs() })
        cached = env.session.origin to runtime
        return runtime
    }

    /** Forget the in-memory runtime (tests, sign-out). Saved files stay until another person signs in. */
    @Synchronized fun reset() { cached = null }
}

/** Pictures for avatars, thumbnails and link previews: memory first, then a small disk cache, then the network. */
class ChatImages(private val api: ChatApi, private val dir: File) {
    private val memory = object : LruCache<String, Bitmap>(((Runtime.getRuntime().maxMemory() / 8).coerceAtMost(48L * 1024 * 1024)).toInt()) {
        override fun sizeOf(key: String, value: Bitmap) = value.byteCount
    }
    private var writes = 0

    fun cached(url: String, maxDim: Int): Bitmap? = memory.get("$url@$maxDim")

    fun load(url: String, maxDim: Int): Bitmap? {
        cached(url, maxDim)?.let { return it }
        val file = File(dir, Hashes.sha256Hex(url.toByteArray()).take(40))
        var bytes: ByteArray? = if (file.exists()) runCatching { file.readBytes() }.getOrNull() else null
        if (bytes == null) {
            bytes = runCatching { api.download(url, 12L * 1024 * 1024) }.getOrNull() ?: return null
            runCatching { dir.mkdirs(); file.writeBytes(bytes); prune() }
        }
        val bmp = decode(bytes, maxDim) ?: return null
        memory.put("$url@$maxDim", bmp)
        return bmp
    }

    private fun prune() {
        if (++writes % 20 != 0) return
        val files = dir.listFiles()?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        for (f in files) { if (total <= MAX_DISK) break; total -= f.length(); f.delete() }
    }

    companion object {
        private const val MAX_DISK = 40L * 1024 * 1024
        fun decode(bytes: ByteArray, maxDim: Int): Bitmap? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (bounds.outWidth / (sample * 2) >= maxDim && bounds.outHeight / (sample * 2) >= maxDim) sample *= 2
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
        }
    }
}
