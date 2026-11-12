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
class ChatRuntime(val api: ChatApi, val repository: ChatRepository, val images: ChatImages, val filesDir: File,
    private val session: ChatSession? = null, private val account: String? = null, draftsFile: File? = null) {
    /** Half-written messages, one per conversation or thread; kept on this phone until sent or emptied. */
    val drafts = DraftStore(draftsFile)
    @Volatile internal var closed = false

    /** False once this person's chat is retired (signed out, or another account signed in): stop polling and sending. */
    val active: Boolean get() = !closed && (session == null || session.account() == account)
}

/**
 * Unsent messages for one account, saved to [file] (under the account's chat folder, so sign-out or another
 * account signing in deletes them). Saving happens off the calling thread; a draft untouched for 30 days is dropped.
 */
class DraftStore(private val file: File?, private val now: () -> Long = System::currentTimeMillis) {
    private val drafts = LinkedHashMap<String, Pair<ComposerDraft, Long>>()
    private val writer by lazy { java.util.concurrent.Executors.newSingleThreadExecutor { r -> Thread(r, "chat-drafts").apply { isDaemon = true } } }

    init {
        runCatching {
            val saved = JSONObject(file!!.readText())
            for (key in saved.keys()) {
                val entry = saved.getJSONObject(key)
                val at = entry.optLong("at")
                val draft = ComposerDraft.fromJson(entry.getJSONObject("draft"))
                if (draft.hasContent() && now() - at <= MAX_AGE_MS) drafts[key] = draft to at
            }
        }
    }

    @Synchronized operator fun get(key: String): ComposerDraft? = drafts[key]?.first

    @Synchronized operator fun set(key: String, draft: ComposerDraft) {
        if (draft.hasContent()) drafts[key] = draft to now() else drafts.remove(key)
        persist()
    }

    @Synchronized fun remove(key: String) { if (drafts.remove(key) != null) persist() }

    /** Blocks until pending saves are on disk (tests, and nothing else needs it). */
    fun flush() { if (file != null) writer.submit {}.get() }

    private fun persist() {
        val target = file ?: return
        val json = JSONObject().apply { for ((k, v) in drafts) put(k, JSONObject().put("at", v.second).put("draft", v.first.toJson())) }.toString()
        writer.execute {
            // Never recreate a folder that sign-out deleted.
            if (target.parentFile?.isDirectory != true) return@execute
            runCatching { val tmp = File(target.path + ".tmp"); tmp.writeText(json); if (!tmp.renameTo(target)) { target.writeText(json); tmp.delete() } }
        }
    }

    companion object { const val MAX_AGE_MS = 30L * 24 * 60 * 60 * 1000 }
}

/**
 * Chat state for one signed-in account at a time, kept on disk under [dataRoot]/chat and [cacheRoot].
 * The runtime, saved messages, unsent messages, pictures and opened files belong to exactly one account
 * ([ChatSession.account]) on one origin. When another account signs in, the previous account's runtime is
 * retired before anything is shown or sent, and its saved chat is deleted unless the server confirms the
 * new session belongs to the same person. Android-free, so JVM tests drive it directly.
 */
class ChatAccounts(
    private val dataRoot: File,
    private val cacheRoot: File,
    private val rememberMe: (Set<String>) -> Unit = {},
    private val forgetMe: () -> Unit = {},
    private val images: (ChatApi, File) -> ChatImages = { api, dir -> ChatImages(api, dir) },
) {
    private var current: Pair<String, ChatRuntime>? = null
    private val base get() = File(dataRoot, "chat")

    /**
     * Blocking: call off the main thread. Null when signed out, or when we can't yet confirm who a new session
     * belongs to (first open while offline). The previous account's saved identity is never used for a new session.
     */
    @Synchronized fun runtime(session: ChatSession, http: OkHttpClient): ChatRuntime? {
        val account = session.account()
        if (account == null) { close(); return null }
        val key = Hashes.sha256Hex((session.origin + "|" + account).toByteArray())
        current?.let { (k, rt) -> if (k == key && rt.active) return rt }
        close()
        base.mkdirs()
        val meFile = File(base, "me.json")
        val stored = runCatching { JSONObject(meFile.readText()) }.getOrNull()
        val storedIds = stored?.optJSONArray("ids")?.let { a -> (0 until a.length()).map { a.getString(it) }.toSet() } ?: emptySet()
        var dirName = stored?.optString("dir")?.takeIf { DIR.matches(it) }
        // Bound to this account: once another account signs in, it refuses to send anything.
        val api = ChatApi(session, http, account)
        // `GET /unread` `me` is the canonical chat id; the `/api/me` ids stay as the fallback.
        val canonical = runCatching { api.unread().me?.id }.getOrNull()
        val fresh = listOfNotNull(canonical).toSet() + runCatching { api.myIds() }.getOrDefault(emptySet())
        val ids: Set<String>
        if (stored?.optString("key") == key) ids = storedIds + fresh   // the same session as last time (a restart)
        else {
            // A new session: only the server can say whose it is.
            if (fresh.isEmpty()) return null
            if (stored?.optString("origin") == session.origin && storedIds.intersect(fresh).isNotEmpty()) ids = storedIds + fresh
            else { wipe(); dirName = null; ids = fresh }
        }
        if (ids.isEmpty()) return null
        val dir = dirName ?: Hashes.sha256Hex((session.origin + "|" + ids.sorted().first()).toByteArray()).take(12)
        fun save(newIds: Set<String>) {
            runCatching { base.mkdirs(); meFile.writeText(JSONObject().put("ids", JSONArray(newIds.toList())).put("dir", dir)
                .put("key", key).put("origin", session.origin).toString()) }
            runCatching { rememberMe(newIds) }
        }
        save(ids)
        val user = File(base, "u/$dir").apply { mkdirs() }
        val outbox = Outbox(FileOutboxStore(File(user, "outbox.json")), api)
        var made: ChatRuntime? = null
        val repo = ChatRepository(api, FileChatCache(File(user, "cache")), outbox, initialMeIds = ids, persistMeIds = ::save,
            isActive = { made?.active == true })
        val runtime = ChatRuntime(api, repo, images(api, File(cacheRoot, "$IMAGES/$dir")), File(user, "files").apply { mkdirs() }, session, account,
            draftsFile = File(user, "drafts.json"))
        made = runtime
        current = key to runtime
        return runtime
    }

    /** Retire the in-memory runtime: its polling and sending stop. Saved files stay. */
    @Synchronized fun close() { current?.second?.closed = true; current = null }

    /** Sign-out: retire the runtime and delete every saved message, unsent message, picture and opened file. */
    @Synchronized fun signOut() { close(); wipe() }

    private fun wipe() {
        File(base, "u").deleteRecursively()
        File(base, "me.json").delete()
        for (d in listOf(IMAGES, FILES, CAMERA)) File(cacheRoot, d).deleteRecursively()
        runCatching { forgetMe() }
    }

    companion object {
        const val IMAGES = "chat-images"
        /** Opened downloads and camera shots (the FileProvider's `chat-files/` and `chat-camera/`). */
        const val FILES = "chat-files"
        const val CAMERA = "chat-camera"
        private val DIR = Regex("^[0-9a-f]{1,64}$")
    }
}

object ChatServices {
    @Volatile private var accounts: ChatAccounts? = null

    @Synchronized private fun accounts(context: Context): ChatAccounts = accounts ?: run {
        val app = context.applicationContext ?: context
        ChatAccounts(app.filesDir, app.cacheDir, rememberMe = { UnreadCheck.rememberMe(app, it) }, forgetMe = { UnreadCheck.forget(app) })
            .also { accounts = it }
    }

    /** Blocking: call off the main thread. See [ChatAccounts.runtime]. */
    fun runtime(env: ChatEnvironment): ChatRuntime? = accounts(env.context).runtime(env.session, env.http)

    /** The host app signed out: stop chat and delete everything it saved on this phone. */
    fun signOut(context: Context) = accounts(context).signOut()

    /** Forget the in-memory runtime (tests). Saved files stay until another person signs in or signs out. */
    @Synchronized fun reset() { accounts?.close() }
}

/** Pictures for avatars, thumbnails and link previews: memory first, then a small disk cache, then the network. */
class ChatImages(private val api: ChatApi, private val dir: File) {
    // Made on first use; each account's runtime has its own (pictures are never shared across accounts).
    private val memory by lazy {
        object : LruCache<String, Bitmap>(((Runtime.getRuntime().maxMemory() / 8).coerceAtMost(48L * 1024 * 1024)).toInt()) {
            override fun sizeOf(key: String, value: Bitmap) = value.byteCount
        }
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
