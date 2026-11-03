package com.sunpride.chat

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Every route the screens call, checked against the paths, verbs, query names and bodies in MESSAGING_V2.md. */
class ChatContractTest {
    private lateinit var fake: FakeChatServer
    private lateinit var api: ChatApi
    @Before fun up() { fake = FakeChatServer(); api = ChatApi(TestSession(fake.origin), fake.client()) }
    @After fun down() = fake.close()
    private fun sent(line: String) = fake.bodies.firstOrNull { it.first == line }?.second?.let { if (it.isBlank()) JSONObject() else JSONObject(it) }

    @Test fun `conversation creation bodies match the contract`() {
        api.createDm(Fx.MARIA)
        api.createGroup(listOf(Fx.MARIA, Fx.BOT), "Cebu team")
        api.createChannel("sales-cebu", "Cebu sales", true)
        val posts = fake.bodies.filter { it.first == "POST /api/v1/messaging/conversations" }.map { JSONObject(it.second) }
        assertEquals("dm", posts[0].getString("kind")); assertEquals(listOf(Fx.MARIA), posts[0].getJSONArray("user_ids").let { a -> (0 until a.length()).map { a.getString(it) } })
        assertEquals("group", posts[1].getString("kind")); assertEquals("Cebu team", posts[1].getString("title"))
        assertEquals("channel", posts[2].getString("kind")); assertEquals("sales-cebu", posts[2].getString("title")); assertTrue(posts[2].getBoolean("is_private"))
    }

    @Test fun `message verbs and paths`() {
        api.edit("m 1", "new text")
        api.delete("m1")
        api.react("m1", "👍")
        api.unreact("m1", "👍")
        api.markRead(Fx.CONV, 42)
        api.messages(Fx.CONV, afterSeq = 5, limit = 10, thread = "p1")
        api.setMuted(Fx.CONV, true)
        api.addMembers(Fx.CONV, listOf(Fx.MARIA))
        api.leave(Fx.CONV, Fx.ME)
        api.join(Fx.CONV)
        val lines = fake.requests.toList()
        assertTrue(lines.contains("PATCH /api/v1/messaging/messages/m%201"))
        assertTrue(lines.contains("DELETE /api/v1/messaging/messages/m1"))
        assertTrue(lines.contains("POST /api/v1/messaging/messages/m1/reactions"))
        assertTrue(lines.contains("DELETE /api/v1/messaging/messages/m1/reactions/%F0%9F%91%8D"))
        assertTrue(lines.contains("POST /api/v1/messaging/conversations/${Fx.CONV}/read"))
        assertTrue(lines.contains("GET /api/v1/messaging/conversations/${Fx.CONV}/messages?after_seq=5&limit=10&thread=p1"))
        assertTrue(lines.contains("PATCH /api/v1/messaging/conversations/${Fx.CONV}"))
        assertTrue(lines.contains("POST /api/v1/messaging/conversations/${Fx.CONV}/members"))
        assertTrue(lines.contains("DELETE /api/v1/messaging/conversations/${Fx.CONV}/members/${Fx.ME}"))
        assertTrue(lines.contains("POST /api/v1/messaging/conversations/${Fx.CONV}/join"))
        assertEquals("new text", sent("PATCH /api/v1/messaging/messages/m%201")!!.getString("body"))
        assertEquals("👍", sent("POST /api/v1/messaging/messages/m1/reactions")!!.getString("emoji"))
        assertEquals(42, sent("POST /api/v1/messaging/conversations/${Fx.CONV}/read")!!.getLong("seq"))
        assertTrue(sent("PATCH /api/v1/messaging/conversations/${Fx.CONV}")!!.getBoolean("muted"))
    }

    @Test fun `send body carries client_msg_id parent and attachment ids`() {
        api.sendMessage(Fx.CONV, "cid-9", "re: this", "parent-1", listOf("att-1", "att-2"))
        val b = sent("POST /api/v1/messaging/conversations/${Fx.CONV}/messages")!!
        assertEquals("cid-9", b.getString("client_msg_id")); assertEquals("parent-1", b.getString("parent_message_id")); assertEquals(2, b.getJSONArray("attachment_ids").length())
    }

    @Test fun `claim and upload follow the contract and the upload url is resolved against the origin`() {
        val c = api.claim("photo.jpg", "image/jpeg", 40, "abc", "file", null)
        api.upload(c.uploadUrl, ByteArray(40), "image/jpeg")
        val t = api.claim("photo-thumb.jpg", "image/jpeg", 10, "def", "thumb", c.attachmentId)
        val body = sent("POST /api/v1/messaging/attachments/claim")!!
        assertEquals("photo.jpg", body.getString("name")); assertEquals("file", body.getString("role")); assertEquals(40, body.getLong("bytes")); assertFalse(body.has("of_attachment_id"))
        assertTrue(fake.bodies.last { it.first.endsWith("/attachments/claim") }.second.contains("\"of_attachment_id\":\"${c.attachmentId}\""))
        assertTrue(fake.requests.contains("PUT /uploads/${c.attachmentId}")); assertEquals("att-2", t.attachmentId)
    }

    @Test fun `directory refs unread and search parse as the contract shapes`() {
        val people = api.searchUsers("mar", 20)
        assertEquals(listOf("Maria Santos", "Phantasm"), people.map { it.displayName }); assertTrue(people[1].isAgent); assertEquals("Sales supervisor", people[0].roleLabel)
        val refs = api.searchRefs("main", listOf("outlet", "product"), 20)
        assertEquals("Main Street Store", refs[0].title); assertEquals("/stores/o-1", refs[0].href)
        assertTrue(fake.requests.contains("GET /api/v1/messaging/refs/search?q=main&types=outlet%2Cproduct&limit=20"))
        assertTrue(api.resolveRefs(listOf("outlet" to "o-1")).isEmpty())
        assertEquals(1, sent("POST /api/v1/messaging/refs/resolve")!!.getJSONArray("refs").length())
        val u = api.unread(); assertEquals(2, u.total); assertEquals(1, u.mentions); assertEquals(Fx.CONV, u.conversations[0].id)
        val s = api.search("route"); assertEquals("hit-1", s.items[0].message.id); assertEquals("sales-cebu", s.items[0].conversationTitle); assertEquals("c2", s.nextCursor)
    }

    @Test fun `a full contract message round-trips through the cache format`() {
        val o = Fx.message("m1", 7, "see <#outlet:o-1> <@user:${Fx.MARIA}>", refs = JSONArray()
            .put(JSONObject().put("type", "outlet").put("id", "o-1").put("title", "Main Street Store").put("subtitle", "Cebu").put("thumb_url", "/t.jpg").put("href", "/stores/o-1").put("access", "ok")))
            .put("attachments", JSONArray().put(JSONObject().put("id", "a1").put("name", "x.pdf").put("mime", "application/pdf").put("bytes", 1200).put("width", JSONObject.NULL)
                .put("height", JSONObject.NULL).put("url", "/api/v1/messaging/attachments/a1").put("thumb_url", JSONObject.NULL).put("kind", "file")))
            .put("reactions", JSONArray().put(JSONObject().put("emoji", "👍").put("count", 2).put("mine", true)))
            .put("links", JSONArray().put(JSONObject().put("url", "https://a.test").put("title", "A").put("description", JSONObject.NULL).put("image_url", JSONObject.NULL).put("site_name", "A site").put("status", "ready")))
            .put("mentions_me", true).put("edited", true).put("reply_count", 3).put("last_reply_at", "2026-11-03T02:00:00.000Z")
        val m = ChatMessage.from(o)
        assertEquals(m, ChatMessage.from(m.toJson()))
        assertTrue(m.mentionsMe && m.edited); assertEquals("file", m.attachments[0].kind); assertTrue(m.reactions[0].mine); assertTrue(m.links[0].ready)
        assertEquals("Main Street Store", m.refs[0].title)
        val c = Conversation.from(Fx.conversation(unread = 3, last = o))
        assertEquals(c, Conversation.from(c.toJson()))
    }

    @Test fun `partner or non-member 404 and 403 map to plain words`() {
        try { api.conversation("someone-elses"); fail() } catch (e: ChatException.Api) { assertEquals(404, e.status); assertEquals("That conversation or message isn't available any more.", ChatErrors.words(e)) }
        assertEquals("You can't do that here.", ChatErrors.words(ChatException.Api(403, "forbidden", null)))
        assertEquals("You're sending too fast. Wait a moment and try again.", ChatErrors.words(ChatException.RateLimited()))
    }
}

class AttachmentRulesTest {
    @Test fun `allowed types are exactly the contract list and phones' odd types are normalised`() {
        assertEquals(11, AttachmentRules.ALL.size)
        assertEquals("text/csv", AttachmentRules.normalize("text/comma-separated-values", "list.csv"))
        assertEquals("image/jpeg", AttachmentRules.normalize("image/jpg", "p.jpg"))
        assertEquals("application/pdf", AttachmentRules.normalize("application/octet-stream", "Invoice.PDF"))
        assertEquals("application/zip", AttachmentRules.normalize("application/x-zip-compressed", "a.zip"))
        assertNull(AttachmentRules.normalize("application/x-msdownload", "setup.exe"))
        assertNull(AttachmentRules.normalize("video/mp4", "clip.mp4"))
    }

    @Test fun `size and empty files are refused with a sentence`() {
        assertNull(AttachmentRules.problem("a.pdf", "application/pdf", 25L * 1024 * 1024))
        assertTrue(AttachmentRules.problem("a.pdf", "application/pdf", 25L * 1024 * 1024 + 1)!!.contains("25 MB"))
        assertNotNull(AttachmentRules.problem("a.pdf", "application/pdf", 0))
        assertNotNull(AttachmentRules.problem("a.exe", null, 10))
    }

    @Test fun `thumbnail fits 320 px on the longest side and never enlarges`() {
        assertEquals(320 to 240, AttachmentRules.fit(4000, 3000)); assertEquals(180 to 320, AttachmentRules.fit(1080, 1920))
        assertEquals(200 to 100, AttachmentRules.fit(200, 100)); assertEquals(320 to 1, AttachmentRules.fit(5000, 1))
    }
}

class UnreadDiffTest {
    private val me = setOf(Fx.ME)
    private fun conv(id: String, kind: String, muted: Boolean = false) =
        Conversation.from(Fx.conversation(id = id, kind = kind, title = if (kind == "dm") null else "team", last = Fx.message("m", 3, "hello there")).put("muted", muted))

    @Test fun `first check only sets the baseline`() {
        assertTrue(UnreadDiff.decide(null, listOf(UnreadConversation("c1", 4, 1)), { conv("c1", "dm") }, me).isEmpty())
    }

    @Test fun `new direct messages and new mentions notify, other group chatter does not`() {
        val before = mapOf("dm" to (1 to 0), "grp" to (0 to 0), "ch" to (2 to 0))
        val now = listOf(UnreadConversation("dm", 2, 0), UnreadConversation("grp", 5, 0), UnreadConversation("ch", 3, 1))
        val items = UnreadDiff.decide(before, now, { id -> when (id) { "dm" -> conv("dm", "dm"); "grp" -> conv("grp", "group"); else -> conv("ch", "channel") } }, me)
        assertEquals(listOf("dm", "ch"), items.map { it.conversationId })
        assertFalse(items[0].mention); assertTrue(items[1].mention)
        assertTrue(items[1].title.contains("mentioned you")); assertFalse(items.any { it.text.contains("<") })
    }

    @Test fun `muted direct chats and unchanged counts stay quiet`() {
        val items = UnreadDiff.decide(mapOf("dm" to (1 to 0)), listOf(UnreadConversation("dm", 3, 0)), { conv("dm", "dm", muted = true) }, me)
        assertTrue(items.isEmpty())
        assertTrue(UnreadDiff.decide(mapOf("dm" to (3 to 0)), listOf(UnreadConversation("dm", 3, 0)), { conv("dm", "dm") }, me).isEmpty())
    }
}
