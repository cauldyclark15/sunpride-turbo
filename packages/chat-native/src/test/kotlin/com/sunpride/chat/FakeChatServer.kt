package com.sunpride.chat

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Fixtures shaped exactly like docs/architecture/MESSAGING_V2.md. */
object Fx {
    const val ME = "11111111-1111-4111-8111-111111111111"
    const val MARIA = "22222222-2222-4222-8222-222222222222"
    const val BOT = "33333333-3333-4333-8333-333333333333"
    const val CONV = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

    fun user(id: String, name: String, agent: Boolean = false) = JSONObject().put("id", id).put("display_name", name)
        .put("avatar_url", JSONObject.NULL).put("is_agent", agent)

    fun message(id: String, seq: Long, body: String, author: String = MARIA, name: String = "Maria Santos", conv: String = CONV,
        at: String = "2026-11-03T01:00:00.000Z", parent: String? = null, refs: JSONArray = JSONArray()) = JSONObject()
        .put("id", id).put("conversation_id", conv).put("seq", seq).put("author", user(author, name)).put("body", body)
        .put("parent_message_id", parent ?: JSONObject.NULL).put("reply_count", 0).put("last_reply_at", JSONObject.NULL)
        .put("attachments", JSONArray()).put("refs", refs).put("mentions_me", false).put("reactions", JSONArray())
        .put("links", JSONArray()).put("edited", false).put("deleted", false).put("created_at", at)

    /** `last_message` exactly as the API sends it (MessageLite). */
    fun lite(m: JSONObject) = JSONObject().put("id", m.get("id")).put("seq", m.get("seq")).put("author", m.get("author"))
        .put("body", m.get("body")).put("created_at", m.get("created_at")).put("deleted", m.optBoolean("deleted", false))

    fun conversation(id: String = CONV, kind: String = "dm", title: String? = null, unread: Int = 0, last: JSONObject? = null) = JSONObject()
        .put("id", id).put("kind", kind).put("title", title ?: JSONObject.NULL).put("topic", JSONObject.NULL).put("is_private", false)
        .put("members_preview", JSONArray().put(user(ME, "Me Myself")).put(user(MARIA, "Maria Santos")))
        .put("member_count", 2).put("unread_count", unread).put("mention_count", 0)
        .put("last_message", last ?: JSONObject.NULL).put("muted", false).put("updated_at", "2026-11-03T01:00:00.000Z")
}

/** An in-memory Sunpride messaging server on a local socket. Replays of a client_msg_id return the original. */
class FakeChatServer : AutoCloseable {
    val server = MockWebServer()
    val requests = java.util.concurrent.CopyOnWriteArrayList<String>()
    /** "METHOD path" paired with the JSON body that was sent ("" when none). */
    val bodies = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String>>()
    @Volatile var down = false
    @Volatile var rejectBodies = emptySet<String>()   // bodies answered with 422 invalid
    @Volatile var authFailuresLeft = 0
    @Volatile var refuseUploads = false
    @Volatile var bearersSeen = java.util.concurrent.CopyOnWriteArrayList<String?>()
    val sent = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()           // distinct messages created
    private val byClientId = HashMap<String, JSONObject>()
    private var seq = 0L
    val messages = java.util.concurrent.CopyOnWriteArrayList<JSONObject>()
    val uploads = java.util.concurrent.CopyOnWriteArrayList<String>()
    private var attachmentCounter = 0

    init {
        server.dispatcher = object : Dispatcher() {
            // MockWebServer asks peek() first; a response that says DISCONNECT_AT_START there drops the socket.
            override fun peek(): MockResponse = if (down) MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START) else super.peek()
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (down) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)
                val line = request.method + " " + request.path
                requests.add(line)
                bodies.add(line to request.body.clone().readUtf8())
                bearersSeen.add(request.getHeader("Authorization"))
                if (authFailuresLeft > 0) { authFailuresLeft--; return MockResponse().setResponseCode(401).setBody("{}") }
                val path = request.path!!.substringBefore('?')
                return synchronized(this@FakeChatServer) { route(request, path) }
            }
        }
        server.start()
    }

    val origin: String get() = server.url("/").toString().trimEnd('/')

    private fun json(code: Int, body: Any) = MockResponse().setResponseCode(code).setHeader("Content-Type", "application/json").setBody(body.toString())

    private fun route(r: RecordedRequest, path: String): MockResponse {
        val m = Regex("^/api/v1/messaging/conversations/([^/]+)/messages$").find(path)
        when {
            path == "/api/me" -> return json(200, JSONObject().put("version", 2).put("profile", JSONObject().put("id", "profile-1").put("subject", Fx.ME)))
            path == "/api/v1/messaging/conversations" && r.method == "GET" ->
                return json(200, JSONObject().put("items", JSONArray().put(Fx.conversation(unread = 2, last = messages.lastOrNull()?.let(Fx::lite)))).put("next_cursor", JSONObject.NULL))
            path == "/api/v1/messaging/conversations" && r.method == "POST" -> return json(201, Fx.conversation())
            path.startsWith("/api/v1/messaging/messages/") && r.method == "PATCH" -> return json(200, Fx.message("m-edited", 9, JSONObject(r.body.readUtf8()).getString("body")).put("edited", true))
            path.endsWith("/read") && r.method == "POST" -> return json(200, JSONObject().put("ok", true))
            path == "/api/v1/messaging/users/search" -> return json(200, JSONArray().put(Fx.user(Fx.MARIA, "Maria Santos").put("role_label", "Sales supervisor")).put(Fx.user(Fx.BOT, "Phantasm", true).put("role_label", "AI user")))
            path == "/api/v1/messaging/refs/search" -> return json(200, JSONArray().put(JSONObject().put("type", "outlet").put("id", "o-1").put("title", "Main Street Store")
                .put("subtitle", "Cebu City").put("thumb_url", JSONObject.NULL).put("href", "/stores/o-1").put("access", "ok")))
            path == "/api/v1/messaging/refs/resolve" -> return json(200, JSONArray())
            path == "/api/v1/messaging/search" -> return json(200, JSONObject().put("items", JSONArray().put(Fx.message("hit-1", 4, "route plan", conv = Fx.CONV)
                .put("conversation", JSONObject().put("id", Fx.CONV).put("title", "sales-cebu").put("kind", "channel")))).put("next_cursor", "c2"))
            path == "/api/v1/messaging/unread" ->
                return json(200, JSONObject().put("me", JSONObject().put("id", Fx.ME).put("display_name", "Me Myself")).put("total", 2).put("mentions", 1).put("conversations", JSONArray().put(JSONObject().put("id", Fx.CONV).put("unread_count", 2).put("mention_count", 1))))
            m != null && r.method == "GET" -> {
                val q = r.requestUrl!!
                val limit = q.queryParameter("limit")?.toInt() ?: 50
                val before = q.queryParameter("before_seq")?.toLong()
                var list = messages.filter { it.optString("parent_message_id", "") == "" || it.isNull("parent_message_id") }
                if (before != null) list = list.filter { it.getLong("seq") < before }
                val page = list.takeLast(limit)
                return json(200, JSONObject().put("items", JSONArray(page)).put("has_more", list.size > page.size))
            }
            m != null && r.method == "POST" -> {
                val body = JSONObject(r.body.readUtf8())
                val cid = body.getString("client_msg_id")
                byClientId[cid]?.let { return json(200, it) }
                if (body.getString("body") in rejectBodies) return json(422, JSONObject().put("error", JSONObject().put("code", "invalid").put("message", "bad")))
                seq = maxOf(seq, messages.maxOfOrNull { it.getLong("seq") } ?: 0L) + 1
                val msg = Fx.message("msg-$seq", seq, body.getString("body"), Fx.ME, "Me Myself", m.groupValues[1], "2026-11-03T05:00:00.000Z")
                    .put("parent_message_id", body.opt("parent_message_id") ?: JSONObject.NULL)
                body.optJSONArray("attachment_ids")?.let { ids ->
                    msg.put("attachments", JSONArray((0 until ids.length()).map {
                        JSONObject().put("id", ids.getString(it)).put("name", "photo.jpg").put("mime", "image/jpeg").put("bytes", 10)
                            .put("width", 100).put("height", 80).put("url", "/api/v1/messaging/attachments/${ids.getString(it)}")
                            .put("thumb_url", JSONObject.NULL).put("kind", "image")
                    }))
                }
                byClientId[cid] = msg; sent.add(msg); messages.add(msg)
                return json(201, msg)
            }
            path == "/api/v1/messaging/attachments/claim" -> {
                val body = JSONObject(r.body.readUtf8())
                val id = "att-${++attachmentCounter}"
                uploads.add("claim:" + body.getString("role") + ":" + id)
                return json(200, JSONObject().put("attachment_id", id).put("upload_url", "/uploads/$id?token=spu_$id").put("expires_at", "2026-11-03T02:00:00.000Z"))
            }
            path.startsWith("/uploads/") && r.method == "PUT" -> {
                // Like the API: the URL's own single-use token is the only credential.
                val id = path.removePrefix("/uploads/")
                if (refuseUploads || r.requestUrl?.queryParameter("token") != "spu_$id")
                    return json(401, JSONObject().put("error", JSONObject().put("code", "upload_unauthorized").put("message", "Upload link expired or invalid")))
                uploads.add("put:" + id + ":" + r.body.size); return MockResponse().setResponseCode(204)
            }
        }
        if (r.method in setOf("PATCH", "DELETE", "POST") && path.startsWith("/api/v1/messaging/") && !path.startsWith("/api/v1/messaging/attachments/")) return json(200, JSONObject().put("ok", true))
        return json(404, JSONObject().put("error", JSONObject().put("code", "not_found").put("message", "No such thing")))
    }

    fun client(): OkHttpClient = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS)
        .followRedirects(false).build()

    override fun close() { server.shutdown() }
}

class TestSession(override val origin: String) : ChatSession {
    override val appHeader = "field-android"
    var forced = 0
    var invalidated = 0
    override fun accessToken(forceRefresh: Boolean): String { if (forceRefresh) forced++; return if (forceRefresh) "spa_fresh" else "spa_token" }
    override fun invalidate() { invalidated++ }
    override fun account(): String? = "test-account"
}
