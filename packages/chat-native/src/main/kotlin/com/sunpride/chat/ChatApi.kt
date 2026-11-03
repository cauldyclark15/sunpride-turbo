package com.sunpride.chat

import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException

/**
 * What the module needs from a host app: its v2 origin and its existing bearer. The app adapter wraps
 * the app's own AuthClient, so tokens and sessions stay where they already live.
 */
interface ChatSession {
    /** `https://host`, no path. */
    val origin: String
    /** `X-App` value the app already sends on v2 calls. */
    val appHeader: String
    /** Blocking. Throws [ChatException.SessionExpired] or [ChatException.Offline]. */
    fun accessToken(forceRefresh: Boolean): String
    fun invalidate()
    fun extraHeaders(): Map<String, String> = emptyMap()
    /**
     * Who is signed in, as a stable non-secret id of the stored session ([ChatAccount.of]); null when signed out.
     * It changes whenever another session (another person) signs in, and chat state is keyed by it.
     */
    fun account(): String?
}

object ChatAccount {
    /** A one-way id for a stored `sps_` session: never the token itself, and never reversible to it. */
    fun of(storedSession: String?): String? = storedSession?.takeIf { it.startsWith("sps_") }
        ?.let { Hashes.sha256Hex("sunpride-chat-account|$it".toByteArray()).take(32) }
}

/**
 * For host adapters that keep their own auth client: drops that client's cached access token whenever the
 * signed-in account changes, so a token minted for the previous person is never sent for the next one.
 */
class AccountTokenGuard(private val account: () -> String?, private val invalidate: () -> Unit) {
    private var seen: String? = null
    private var primed = false
    fun <T> token(fetch: () -> T): T {
        synchronized(this) {
            val now = account()
            if (!primed || now != seen) { invalidate(); seen = now; primed = true }
        }
        return fetch()
    }
    /** Sign-out: the next token is fetched fresh whatever happens. */
    @Synchronized fun reset() { primed = false; invalidate() }
}

sealed class ChatException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    class Offline(cause: Throwable? = null) : ChatException("offline", cause)
    class SessionExpired : ChatException("session expired")
    class RateLimited : ChatException("rate limited")
    class Server(val status: Int) : ChatException("server $status")
    /** A 4xx the server explained with its error envelope. 404 means "not a member or gone". */
    class Api(val status: Int, val code: String?, detail: String?) : ChatException(detail ?: code ?: "refused $status")

    /** Worth retrying later (the same request may succeed): never a refusal about the content itself. */
    val retryable: Boolean get() = this is Offline || this is Server || this is RateLimited || this is SessionExpired
}

/** Plain business English for any failure; no codes, no status numbers. */
object ChatErrors {
    fun words(e: Throwable): String = when (e) {
        is ChatException.Offline -> "You're offline. Saved messages are shown, and anything you send will go when you're back online."
        is ChatException.SessionExpired -> "Your sign-in has ended. Open the app's Account page to sign in again."
        is ChatException.RateLimited -> "You're sending too fast. Wait a moment and try again."
        is ChatException.Server -> "The office server had a problem. Try again in a moment."
        is ChatException.Api -> when {
            e.status == 404 -> "That conversation or message isn't available any more."
            e.status == 403 -> "You can't do that here."
            e.code == "invalid" -> "That wasn't accepted. Check the message and try again."
            else -> "That didn't work. Try again."
        }
        else -> "Something went wrong. Try again."
    }
}

/**
 * All the messaging routes (under /api/v1/messaging) the screens use. Blocking; callers run it off the main thread.
 * With an [account], every authorized call first checks that account is still the one signed in, and refuses
 * ([ChatException.SessionExpired]) otherwise: an old account's outbox is never sent with a new account's bearer.
 */
class ChatApi(private val session: ChatSession, private val http: OkHttpClient, private val account: String? = null) {
    private val base = session.origin.trimEnd('/')
    private val originUrl: HttpUrl? = base.toHttpUrlOrNull()

    // ---- conversations ----
    fun conversations(cursor: String? = null): ConversationPage {
        val o = getObject("/conversations", "cursor" to cursor)
        return ConversationPage(o.arr("items").mapObjects(Conversation::from), o.str("next_cursor"))
    }
    fun createDm(userId: String) = Conversation.from(post("/conversations", JSONObject().put("kind", "dm").put("user_ids", JSONArray(listOf(userId)))))
    fun createGroup(userIds: List<String>, title: String?) = Conversation.from(post("/conversations",
        JSONObject().put("kind", "group").put("user_ids", JSONArray(userIds)).apply { if (!title.isNullOrBlank()) put("title", title.trim()) }))
    fun createChannel(title: String, topic: String?, isPrivate: Boolean) = Conversation.from(post("/conversations",
        JSONObject().put("kind", "channel").put("title", title.trim()).put("is_private", isPrivate).apply { if (!topic.isNullOrBlank()) put("topic", topic.trim()) }))
    fun conversation(id: String) = ConversationDetail.from(getObject("/conversations/${enc(id)}"))
    fun setMuted(id: String, muted: Boolean) = send("PATCH", "/conversations/${enc(id)}", JSONObject().put("muted", muted))
    fun addMembers(id: String, userIds: List<String>) = send("POST", "/conversations/${enc(id)}/members", JSONObject().put("user_ids", JSONArray(userIds)))
    fun leave(id: String, userId: String) { send("DELETE", "/conversations/${enc(id)}/members/${enc(userId)}", null) }
    fun browseChannels(q: String): List<Conversation> = getObject("/channels/browse", "q" to q).let { o ->
        // the contract says "public channels"; accept either a bare list or {items:[…]}
        o.arr("items").mapObjects(Conversation::from)
    }
    fun join(id: String) = send("POST", "/conversations/${enc(id)}/join", JSONObject())

    // ---- messages ----
    fun messages(conversationId: String, beforeSeq: Long? = null, afterSeq: Long? = null, limit: Int = 50, thread: String? = null): MessagePage {
        val o = getObject("/conversations/${enc(conversationId)}/messages", "before_seq" to beforeSeq?.toString(),
            "after_seq" to afterSeq?.toString(), "limit" to limit.toString(), "thread" to thread)
        return MessagePage(o.arr("items").mapObjects(ChatMessage::from), o.optBoolean("has_more", false))
    }
    fun sendMessage(conversationId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: List<String>): SendResult {
        val payload = JSONObject().put("client_msg_id", clientMsgId).put("body", body)
        if (parentId != null) payload.put("parent_message_id", parentId)
        if (attachmentIds.isNotEmpty()) payload.put("attachment_ids", JSONArray(attachmentIds))
        val (status, json) = request("POST", "/conversations/${enc(conversationId)}/messages", payload)
        return SendResult(ChatMessage.from(json as JSONObject), status == 200)
    }
    fun edit(messageId: String, body: String) = ChatMessage.from(send("PATCH", "/messages/${enc(messageId)}", JSONObject().put("body", body)))
    fun delete(messageId: String) { send("DELETE", "/messages/${enc(messageId)}", null) }
    fun react(messageId: String, emoji: String) { send("POST", "/messages/${enc(messageId)}/reactions", JSONObject().put("emoji", emoji)) }
    fun unreact(messageId: String, emoji: String) { send("DELETE", "/messages/${enc(messageId)}/reactions/${enc(emoji)}", null) }
    fun markRead(conversationId: String, seq: Long) { send("POST", "/conversations/${enc(conversationId)}/read", JSONObject().put("seq", seq)) }

    // ---- attachments ----
    fun claim(name: String, mime: String, bytes: Long, sha256: String, role: String, ofAttachmentId: String?): ClaimedUpload {
        val body = JSONObject().put("name", name).put("mime", mime).put("bytes", bytes).put("sha256", sha256).put("role", role)
        if (ofAttachmentId != null) body.put("of_attachment_id", ofAttachmentId)
        val o = post("/attachments/claim", body)
        return ClaimedUpload(o.getString("attachment_id"), o.getString("upload_url"), o.str("expires_at"))
    }
    /**
     * `PUT upload_url` with the raw bytes: a plain PUT. The URL carries its own single-use upload token, so no
     * bearer is sent, and a refused link (401) is an upload failure, never a signed-out session.
     */
    fun upload(uploadUrl: String, bytes: ByteArray, mime: String) {
        val url = absolute(uploadUrl)
        val media = mime.toMediaTypeOrNull()
        val req = Request.Builder().url(url).put(bytes.toRequestBody(media)).build()
        try {
            http.newCall(req).execute().use { r -> if (r.code !in 200..299) throw failure(r.code, r.body?.string().orEmpty()) }
        } catch (e: IOException) { throw ChatException.Offline(e) }
    }
    /** Image/file bytes for an attachment, link image or avatar. Third-party hosts get no credentials. */
    fun download(url: String, maxBytes: Long = 30L * 1024 * 1024): ByteArray {
        val abs = absolute(url)
        val req = Request.Builder().url(abs).get().apply { authorize(this, abs) }.build()
        return execute(req, retryAuth = sameOrigin(abs)) { code, body ->
            if (code !in 200..299) throw failure(code, "")
            val stream = body?.byteStream() ?: throw ChatException.Server(code)
            val out = java.io.ByteArrayOutputStream()
            val buf = ByteArray(16 * 1024); var total = 0L
            while (true) {
                val n = stream.read(buf); if (n < 0) break
                total += n; if (total > maxBytes) throw ChatException.Api(413, "invalid", "too large")
                out.write(buf, 0, n)
            }
            out.toByteArray()
        }
    }

    // ---- directory, unread, search ----
    fun searchUsers(q: String, limit: Int = 20): List<UserLite> = getArray("/users/search", "q" to q, "limit" to limit.toString()).mapObjects(UserLite::from)
    fun searchRefs(q: String, types: List<String>, limit: Int = 20): List<RefEntry> =
        getArray("/refs/search", "q" to q, "types" to types.takeIf { it.isNotEmpty() }?.joinToString(","), "limit" to limit.toString()).mapObjects(RefEntry::from)
    fun resolveRefs(refs: List<Pair<String, String>>): List<RefEntry> {
        val body = JSONObject().put("refs", JSONArray(refs.take(100).map { JSONObject().put("type", it.first).put("id", it.second) }))
        val (_, json) = request("POST", "/refs/resolve", body)
        return (json as? JSONArray ?: (json as JSONObject).arr("items")).mapObjects(RefEntry::from)
    }
    fun unread(): UnreadSummary = UnreadSummary.from(getObject("/unread"))
    fun search(q: String, cursor: String? = null): SearchPage {
        val o = getObject("/search", "q" to q, "cursor" to cursor)
        return SearchPage(o.arr("items").mapObjects { m ->
            val c = m.obj("conversation")
            SearchHit(ChatMessage.from(m), c?.str("id") ?: m.str("conversation_id") ?: "", c?.str("title"), c?.str("kind"))
        }, o.str("next_cursor"))
    }

    /** `GET /api/me` (outside the messaging prefix) to learn who "me" is. Returns every id that may name me. */
    fun myIds(): Set<String> {
        val url = "$base/api/me".toHttpUrlOrNull() ?: return emptySet()
        val req = Request.Builder().url(url).get().apply { authorize(this, url) }.build()
        val o = execute(req, true) { code, body ->
            val text = body?.string().orEmpty()
            if (code !in 200..299) throw failure(code, text)
            JSONObject(text.ifEmpty { "{}" })
        }
        val ids = LinkedHashSet<String>()
        listOf(o.obj("profile"), o.obj("user")).forEach { p ->
            p?.let { x -> listOf("id", "subject", "userId", "user_id").forEach { k -> x.str(k)?.let { v -> ids.add(v); ids.add(v.substringAfterLast(':')) } } }
        }
        return ids.filter { it.isNotBlank() }.toSet()
    }

    // ---- plumbing ----
    private fun enc(s: String): String = java.net.URLEncoder.encode(s, "UTF-8").replace("+", "%20")
    private fun getObject(path: String, vararg query: Pair<String, String?>): JSONObject {
        val (_, json) = request("GET", path, null, query.toList())
        return json as? JSONObject ?: JSONObject().put("items", json)
    }
    private fun getArray(path: String, vararg query: Pair<String, String?>): JSONArray {
        val (_, json) = request("GET", path, null, query.toList())
        return json as? JSONArray ?: (json as JSONObject).arr("items")
    }
    private fun post(path: String, body: JSONObject): JSONObject = send("POST", path, body)
    private fun send(method: String, path: String, body: JSONObject?): JSONObject {
        val (_, json) = request(method, path, body)
        return json as? JSONObject ?: JSONObject()
    }
    private fun absolute(u: String): HttpUrl =
        (if (u.startsWith("http://") || u.startsWith("https://")) u else base + (if (u.startsWith("/")) u else "/$u")).toHttpUrlOrNull()
            ?: throw ChatException.Api(400, "invalid", "bad url")
    private fun sameOrigin(url: HttpUrl) = originUrl != null && url.host == originUrl.host && url.port == originUrl.port && url.scheme == originUrl.scheme
    private fun authorize(b: Request.Builder, url: HttpUrl, forceRefresh: Boolean = false) {
        if (!sameOrigin(url)) return
        stillSignedIn()
        val token = session.accessToken(forceRefresh)
        stillSignedIn()   // again: the account may have changed while the token was fetched
        b.header("Authorization", "Bearer $token").header("X-App", session.appHeader)
        session.extraHeaders().forEach { (k, v) -> b.header(k, v) }
    }

    private fun stillSignedIn() { if (account != null && session.account() != account) throw ChatException.SessionExpired() }

    private fun request(method: String, path: String, body: JSONObject?, query: List<Pair<String, String?>> = emptyList()): Pair<Int, Any> {
        val builder = (base + API + path).toHttpUrlOrNull()?.newBuilder() ?: throw ChatException.Api(400, "invalid", "bad origin")
        query.forEach { (k, v) -> if (v != null) builder.addQueryParameter(k, v) }
        val url = builder.build()
        val payload = body?.toString()?.toRequestBody(JSON)
        val req = Request.Builder().url(url).method(method, payload ?: if (method == "GET" || method == "HEAD") null else ByteArray(0).toRequestBody(null))
            .header("Accept", "application/json").apply { authorize(this, url) }.build()
        return execute(req, retryAuth = true) { code, rb ->
            val text = rb?.string().orEmpty()
            if (code !in 200..299) throw failure(code, text)
            val parsed: Any = when {
                text.isBlank() -> JSONObject()
                text.trimStart().startsWith("[") -> JSONArray(text)
                else -> JSONObject(text)
            }
            code to parsed
        }
    }

    /** One call with a single token refresh on 401. IO problems are "offline"; malformed JSON is a server fault. */
    private fun <T> execute(req: Request, retryAuth: Boolean, read: (Int, okhttp3.ResponseBody?) -> T): T {
        var current = req
        for (attempt in 0..1) {
            try {
                http.newCall(current).execute().use { r ->
                    if (r.code == 401 && retryAuth) {
                        session.invalidate()
                        if (attempt == 1) throw ChatException.SessionExpired()
                        current = current.newBuilder().apply { authorize(this, current.url, true) }.build()
                    } else if (r.code == 401) throw ChatException.SessionExpired()
                    else return read(r.code, r.body)
                }
            } catch (e: IOException) { throw ChatException.Offline(e) }
            catch (e: org.json.JSONException) { throw ChatException.Server(502) }
        }
        throw ChatException.SessionExpired()
    }

    private fun failure(code: Int, text: String): ChatException {
        if (code == 429) return ChatException.RateLimited()
        if (code >= 500) return ChatException.Server(code)
        val err = runCatching { JSONObject(text).optJSONObject("error") }.getOrNull()
        return ChatException.Api(code, err?.optString("code")?.takeIf { it.isNotEmpty() }, err?.optString("message")?.takeIf { it.isNotEmpty() })
    }

    companion object {
        const val API = "/api/v1/messaging"
        private val JSON = "application/json".toMediaTypeOrNull()
    }
}

/** Both apps' AuthFailure kinds, by name, as chat failures (so the module never imports an app class). */
fun chatFailureForAuthKind(kindName: String): ChatException = when (kindName) {
    "OFFLINE" -> ChatException.Offline()
    "SERVER" -> ChatException.Server(503)
    "RATE_LIMITED" -> ChatException.RateLimited()
    else -> ChatException.SessionExpired()
}
