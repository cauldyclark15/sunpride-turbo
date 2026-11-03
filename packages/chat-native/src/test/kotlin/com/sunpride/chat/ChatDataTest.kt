package com.sunpride.chat

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ChatApiTest {
    private lateinit var fake: FakeChatServer
    private lateinit var session: TestSession
    private lateinit var api: ChatApi
    @Before fun up() { fake = FakeChatServer(); session = TestSession(fake.origin); api = ChatApi(session, fake.client()) }
    @After fun down() = fake.close()

    @Test fun `routes use the contract paths, query names and the app's bearer`() {
        val page = api.conversations()
        assertEquals(1, page.items.size); assertEquals(2, page.items[0].unreadCount); assertNull(page.nextCursor)
        api.messages(Fx.CONV, beforeSeq = 10, limit = 50)
        api.unread()
        assertEquals(listOf("GET /api/v1/messaging/conversations", "GET /api/v1/messaging/conversations/${Fx.CONV}/messages?before_seq=10&limit=50",
            "GET /api/v1/messaging/unread"), fake.requests.toList())
        assertTrue(fake.bearersSeen.all { it == "Bearer spa_token" })
    }

    @Test fun `a 401 refreshes the token once and retries`() {
        fake.authFailuresLeft = 1
        assertEquals(2, api.unread().total)
        assertEquals(1, session.forced); assertEquals(1, session.invalidated)
        assertEquals(listOf("Bearer spa_token", "Bearer spa_fresh"), fake.bearersSeen.toList())
    }

    @Test fun `two 401s in a row mean the session has ended`() {
        fake.authFailuresLeft = 5
        try { api.unread(); fail() } catch (e: ChatException) { assertTrue(e is ChatException.SessionExpired) }
    }

    @Test fun `no network is Offline and a server error envelope becomes Api`() {
        fake.down = true
        try { api.unread(); fail() } catch (e: ChatException) { assertTrue(e is ChatException.Offline); assertTrue(e.retryable) }
        fake.down = false
        try { api.conversation("nope"); fail() } catch (e: ChatException.Api) {
            assertEquals(404, e.status); assertEquals("not_found", e.code); assertFalse(e.retryable)
            assertFalse(ChatErrors.words(e).contains("404"))
        }
    }

    @Test fun `bearer goes only to our own origin when fetching images`() {
        val other = FakeChatServer()
        try {
            // the fake answers 404 for unknown paths; the point is the header that arrived
            try { api.download(other.origin + "/img.jpg") } catch (_: ChatException) {}
            assertTrue(other.bearersSeen.all { it == null })
            try { api.download("/api/v1/messaging/attachments/x") } catch (_: ChatException) {}
            assertEquals("Bearer spa_token", fake.bearersSeen.last())
        } finally { other.close() }
    }

    @Test fun `my ids come from api me`() {
        val ids = api.myIds()
        assertTrue(Fx.ME in ids); assertTrue("profile-1" in ids)
    }

    @Test fun `send returns replay flag from the status`() {
        val first = api.sendMessage(Fx.CONV, "c-1", "hello", null, emptyList())
        val again = api.sendMessage(Fx.CONV, "c-1", "hello", null, emptyList())
        assertFalse(first.replayed); assertTrue(again.replayed); assertEquals(first.message.id, again.message.id)
        assertEquals(1, fake.sent.size)
    }
}

class OutboxTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var fake: FakeChatServer
    private lateinit var api: ChatApi
    private var now = 1_000_000L
    @Before fun up() { fake = FakeChatServer(); api = ChatApi(TestSession(fake.origin), fake.client()) }
    @After fun down() = fake.close()
    private fun outbox(file: File = File(tmp.root, "outbox.json")) = Outbox(FileOutboxStore(file), api, { now })

    @Test fun `offline send is kept, survives a restart, then goes once`() {
        fake.down = true
        val box = outbox()
        val p = box.enqueue(Fx.CONV, "first", null, emptyList(), "cid-1")
        var r = box.flush()
        assertTrue(r.sent.isEmpty()); assertEquals(1, r.stillWaiting)
        assertEquals(1, box.list()[0].attempts); assertEquals(now + Backoff.delayMs(1), box.list()[0].nextAttemptAtMs)

        // app killed and reopened: a brand-new Outbox over the same file
        val reopened = outbox()
        assertEquals(listOf("cid-1"), reopened.list().map { it.clientMsgId })
        assertEquals("first", reopened.list()[0].body)

        fake.down = false
        r = reopened.flush()                       // retry time not reached: nothing happens
        assertTrue(r.sent.isEmpty())
        now += 5_000
        r = reopened.flush()
        assertEquals(1, r.sent.size); assertEquals(p.clientMsgId, r.sent[0].first.clientMsgId)
        assertTrue(reopened.list().isEmpty()); assertTrue(outbox().list().isEmpty())
        assertEquals(1, fake.sent.size)
    }

    @Test fun `a lost reply is replayed with the same client_msg_id and creates no duplicate`() {
        val box = outbox()
        box.enqueue(Fx.CONV, "hello", null, emptyList(), "cid-dup")
        // server got it, but pretend the phone never saw the reply: same id sent again from a fresh outbox
        api.sendMessage(Fx.CONV, "cid-dup", "hello", null, emptyList())
        val r = box.flush(force = true)
        assertEquals(1, r.sent.size)
        assertEquals(1, fake.sent.size)
        assertEquals(fake.sent[0].getString("id"), r.sent[0].second.id)
    }

    @Test fun `messages in one conversation go in the order they were written, even across retries`() {
        val box = outbox()
        fake.down = true
        box.enqueue(Fx.CONV, "one", null, emptyList(), "c1"); box.enqueue(Fx.CONV, "two", null, emptyList(), "c2"); box.enqueue(Fx.CONV, "three", null, emptyList(), "c3")
        box.flush()
        assertEquals(listOf(1, 0, 0), box.list().map { it.attempts })   // later ones wait behind the first
        fake.down = false
        now += 10_000
        val r = box.flush()
        assertEquals(listOf("one", "two", "three"), r.sent.map { it.first.body })
        assertEquals(listOf("one", "two", "three"), fake.sent.map { it.getString("body") })
        assertEquals(listOf(1L, 2L, 3L), fake.sent.map { it.getLong("seq") })
    }

    @Test fun `a message the server refuses is marked not sent and does not block the next one`() {
        fake.rejectBodies = setOf("bad")
        val box = outbox()
        box.enqueue(Fx.CONV, "bad", null, emptyList(), "c1"); box.enqueue(Fx.CONV, "good", null, emptyList(), "c2")
        val r = box.flush()
        assertEquals(listOf("good"), r.sent.map { it.first.body })
        assertEquals(1, r.failed.size)
        val left = box.list().single()
        assertEquals(PendingState.FAILED, left.state); assertNotNull(left.failure)
        fake.rejectBodies = emptySet()
        box.retryNow("c1")
        assertEquals(listOf("bad"), box.flush().sent.map { it.first.body })
    }

    @Test fun `backoff doubles from two seconds up to five minutes`() {
        assertEquals(listOf(0L, 2000L, 4000L, 8000L, 16000L), (0..4).map { Backoff.delayMs(it) })
        assertEquals(300_000L, Backoff.delayMs(20)); assertEquals(300_000L, Backoff.delayMs(500))
    }

    @Test fun `forced flush ignores the retry time (phone came back online)`() {
        fake.down = true
        val box = outbox()
        box.enqueue(Fx.CONV, "x", null, emptyList(), "c1")
        box.flush(); fake.down = false
        assertEquals(1, box.flush(force = true).sent.size)
    }

    @Test fun `photo with thumbnail uploads file then thumb once each and a retry does not re-upload`() {
        val img = tmp.newFile("photo.jpg").apply { writeBytes(ByteArray(40) { 7 }) }
        val th = tmp.newFile("photo-thumb.jpg").apply { writeBytes(ByteArray(10) { 9 }) }
        val box = outbox()
        val att = LocalAttachment(img.path, "photo.jpg", "image/jpeg", 40, Hashes.sha256Hex(img), 100, 80, th.path)
        box.enqueue(Fx.CONV, "look", null, listOf(att), "c-photo")
        val r1 = box.flush()
        assertEquals(1, r1.sent.size)
        assertEquals(listOf("claim:file:att-1", "put:att-1:40", "claim:thumb:att-2", "put:att-2:10"), fake.uploads.toList())
        assertEquals("att-1", r1.sent[0].second.attachments.single().id)
        assertFalse(img.exists()); assertFalse(th.exists())    // local copies removed once delivered
    }

    @Test fun `uploaded attachment ids are remembered when sending fails afterwards`() {
        val img = tmp.newFile("a.jpg").apply { writeBytes(ByteArray(5)) }
        val box = outbox()
        box.enqueue(Fx.CONV, "pic", null, listOf(LocalAttachment(img.path, "a.jpg", "image/jpeg", 5, Hashes.sha256Hex(img))), "c-a")
        fake.rejectBodies = setOf("pic")
        box.flush()
        assertEquals("att-1", box.list().single().attachments.single().attachmentId)
        fake.rejectBodies = emptySet(); box.retryNow("c-a"); box.flush()
        assertEquals(listOf("claim:file:att-1", "put:att-1:5"), fake.uploads.toList())   // not uploaded a second time
    }
}

class ChatRepositoryTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var fake: FakeChatServer
    private var now = 5_000_000L
    @Before fun up() { fake = FakeChatServer() }
    @After fun down() = fake.close()

    private fun repo(dir: File = tmp.root, me: Set<String> = setOf(Fx.ME)): ChatRepository {
        val api = ChatApi(TestSession(fake.origin), fake.client())
        return ChatRepository(api, FileChatCache(File(dir, "cache")), Outbox(FileOutboxStore(File(dir, "outbox.json")), api, { now }),
            { now }, Dispatchers.IO, me)
    }
    private fun seed(n: Int) { for (i in 1..n) fake.messages.add(Fx.message("seed-$i", i.toLong(), "m$i")) }

    @Test fun `keeps the last 50 messages per conversation and reads them with no network`() = runBlocking {
        seed(120)
        val r = repo()
        r.open(Fx.CONV)
        val live = r.state(Fx.CONV).value
        assertEquals(50, live.messages.size); assertEquals(71L, live.messages.first().seq); assertEquals(120L, live.messages.last().seq)
        assertTrue(live.hasMore)

        fake.down = true
        val cold = repo()                                  // restart, offline
        assertEquals(50, cold.state(Fx.CONV).value.messages.size)
        cold.open(Fx.CONV)
        val s = cold.state(Fx.CONV).value
        assertTrue(s.offline); assertEquals(120L, s.messages.last().seq); assertNull(s.error)
    }

    @Test fun `older pages load on demand and the offline copy stays at 50`() = runBlocking {
        seed(120)
        val r = repo(); r.open(Fx.CONV); r.loadOlder(Fx.CONV)
        val s = r.state(Fx.CONV).value
        assertEquals(100, s.messages.size); assertEquals(21L, s.messages.first().seq)
        fake.down = true
        assertEquals(50, repo().state(Fx.CONV).value.messages.size)
    }

    @Test fun `sending offline shows the message as unsent, then delivers it without a duplicate`() = runBlocking {
        seed(2)
        val r = repo(); r.open(Fx.CONV)
        fake.down = true
        r.send(Fx.CONV, "on my way", null)
        var s = r.state(Fx.CONV).value
        assertEquals(listOf("on my way"), s.pending.map { it.body }); assertEquals(2, s.messages.size)

        fake.down = false; now += 10_000
        r.flushOutbox()
        s = r.state(Fx.CONV).value
        assertTrue(s.pending.isEmpty()); assertEquals("on my way", s.messages.last().body)
        assertEquals(1, fake.sent.size)
        r.refresh(Fx.CONV)
        assertEquals(1, r.state(Fx.CONV).value.messages.count { it.body == "on my way" })
    }

    @Test fun `unread names me canonically`() = runBlocking {
        val r = repo(me = emptySet())
        r.refreshUnread()
        assertTrue(Fx.ME in r.myIds.value)
    }

    @Test fun `my own id is learned from a message I sent`() = runBlocking {
        val r = repo(me = emptySet())
        r.send(Fx.CONV, "hi", null)
        assertTrue(Fx.ME in r.myIds.value)
    }

    @Test fun `a conversation list is cached and survives a restart offline`() = runBlocking {
        val r = repo(); r.refreshConversations(); r.refreshUnread()
        assertEquals(1, r.conversations.value.items.size); assertEquals(2, r.unread.value.total)
        fake.down = true
        val cold = repo()
        assertEquals(1, cold.conversations.value.items.size)
        cold.refreshConversations()
        assertTrue(cold.conversations.value.offline); assertEquals(1, cold.conversations.value.items.size)
    }

    @Test fun `a window that does not touch what we hold replaces it so the timeline has no hole`() = runBlocking {
        seed(10)
        val r = repo(); r.open(Fx.CONV)
        for (i in 11..200) fake.messages.add(Fx.message("seed-$i", i.toLong(), "m$i"))
        r.refresh(Fx.CONV)
        val s = r.state(Fx.CONV).value
        assertEquals(151L, s.messages.first().seq); assertEquals(200L, s.messages.last().seq); assertTrue(s.hasMore)
    }

    @Test fun `marking read clears the badge at once`() = runBlocking {
        seed(3)
        val r = repo(); r.refreshConversations(); r.refreshUnread(); r.open(Fx.CONV)
        r.markRead(Fx.CONV)
        assertEquals(0, r.conversations.value.items.single().unreadCount)
        assertEquals(0, r.unread.value.total)
    }
}
