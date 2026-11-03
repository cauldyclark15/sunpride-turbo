package com.sunpride.chat

import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit

/** SP-0148 C2: one phone, two accounts, no process restart. */
class ChatAccountsTest {
    @get:Rule val tmp = TemporaryFolder()
    private lateinit var fake: TwoAccountServer
    private lateinit var session: SwitchSession
    private lateinit var files: File
    private lateinit var cache: File
    private lateinit var accounts: ChatAccounts

    companion object {
        const val USER_A = "aaaaaaaa-1111-4111-8111-111111111111"
        const val USER_B = "bbbbbbbb-2222-4222-8222-222222222222"
        const val CONV_A = "cccccccc-3333-4333-8333-333333333333"
        const val SECRET_TITLE = "Only A sees this"
        const val SECRET_HISTORY = "A private history"
        const val SECRET_UNSENT = "A unsent secret"
    }

    /** Answers as whoever owns the bearer; "A2" is a second session of person A. */
    class TwoAccountServer : AutoCloseable {
        val server = MockWebServer()
        @Volatile var down = false
        @Volatile var identityFailsFor = emptySet<String>()
        val posts = CopyOnWriteArrayList<Pair<String?, String>>()
        val bearers = CopyOnWriteArrayList<String?>()
        init {
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (down) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START)
                    val bearer = request.getHeader("Authorization")
                    bearers.add(bearer)
                    val session = bearer?.removePrefix("Bearer spa_") ?: return json(401, JSONObject())
                    val user = when (session) { "A", "A2" -> USER_A; "B" -> USER_B; else -> return json(401, JSONObject()) }
                    val path = request.requestUrl!!.encodedPath
                    val failsIdentity = session in identityFailsFor
                    return when {
                        path == "/api/me" -> if (failsIdentity) json(500, JSONObject()) else json(200, JSONObject().put("user", JSONObject().put("id", user)))
                        path.endsWith("/unread") -> if (failsIdentity) json(500, JSONObject()) else json(200, JSONObject().put("total", 0)
                            .put("mentions", 0).put("conversations", JSONArray()).put("me", JSONObject().put("id", user).put("display_name", user)))
                        path.endsWith("/conversations") && request.method == "GET" -> json(200, JSONObject().put("next_cursor", JSONObject.NULL)
                            .put("items", if (user == USER_A) JSONArray().put(Fx.conversation(CONV_A, kind = "group", title = SECRET_TITLE)) else JSONArray()))
                        path.endsWith("/messages") && request.method == "POST" -> {
                            val body = request.body.readUtf8()
                            posts.add(bearer to body)
                            val o = JSONObject(body)
                            json(201, Fx.message("dddddddd-4444-4444-8444-${"%012d".format(posts.size)}", posts.size.toLong(), o.getString("body"), author = user, name = user))
                        }
                        path.endsWith("/messages") && user == USER_A -> json(200, JSONObject().put("has_more", false)
                            .put("items", JSONArray().put(Fx.message("eeeeeeee-5555-4555-8555-555555555555", 1, SECRET_HISTORY, conv = CONV_A))))
                        else -> json(404, JSONObject().put("error", JSONObject().put("code", "not_found")))
                    }
                }
            }
            server.start()
        }
        val origin: String get() = server.url("/").toString().trimEnd('/')
        private fun json(code: Int, o: JSONObject) = MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(o.toString())
        fun client(): OkHttpClient = OkHttpClient.Builder().connectTimeout(2, TimeUnit.SECONDS).readTimeout(2, TimeUnit.SECONDS).followRedirects(false).build()
        override fun close() { server.shutdown() }
    }

    /** Like a host adapter over its own auth client: the access token is cached until invalidated. */
    class SwitchSession(override val origin: String) : ChatSession {
        override val appHeader = "field-android"
        @Volatile var who: String? = "A"
        @Volatile private var cached: String? = null
        private val guard = AccountTokenGuard({ account() }, { cached = null })
        override fun account(): String? = ChatAccount.of(who?.let { "sps_session_$it" })
        override fun accessToken(forceRefresh: Boolean): String = guard.token {
            if (forceRefresh || cached == null) cached = who?.let { "spa_$it" } ?: throw ChatException.SessionExpired()
            cached!!
        }
        override fun invalidate() { cached = null }
    }

    @Before fun up() {
        fake = TwoAccountServer(); session = SwitchSession(fake.origin)
        files = tmp.newFolder("files"); cache = tmp.newFolder("cache")
        accounts = ChatAccounts(files, cache)
    }
    @After fun down() = fake.close()

    /** A reads her chat and queues a message while offline. */
    private fun aWithQueuedSend(): ChatRuntime {
        val a = checkNotNull(accounts.runtime(session, fake.client()))
        runBlocking {
            a.repository.refreshConversations()
            a.repository.refresh(CONV_A)
            fake.down = true
            a.repository.send(CONV_A, SECRET_UNSENT, null)
            fake.down = false
        }
        assertEquals(listOf(SECRET_UNSENT), a.repository.outbox.list().map { it.body })
        assertTrue(a.repository.conversations.value.items.any { it.id == CONV_A })
        File(cache, "chat-images/x").apply { parentFile!!.mkdirs(); writeText("A picture") }
        File(cache, "chat-files/y/z.pdf").apply { parentFile!!.mkdirs(); writeText("A download") }
        return a
    }

    private fun assertNothingOfA(b: ChatRuntime) {
        assertTrue(b.repository.conversations.value.items.none { it.id == CONV_A || it.title == SECRET_TITLE })
        assertTrue(b.repository.state(CONV_A).value.messages.isEmpty())
        assertTrue(b.repository.state(CONV_A).value.pending.isEmpty())
        assertTrue(b.repository.outbox.list().isEmpty())
        assertEquals(setOf(USER_B), b.repository.myIds.value)
        val leftovers = (files.walk() + cache.walk()).filter { it.isFile }.filter { f ->
            val t = f.readText(); listOf(SECRET_TITLE, SECRET_HISTORY, SECRET_UNSENT, "A picture", "A download").any { it in t }
        }.toList()
        assertEquals(emptyList<File>(), leftovers)
    }

    @Test fun `switching accounts without a restart shows none of A's chat and never posts A's outbox`() {
        val a = aWithQueuedSend()
        session.who = "B"
        assertFalse(a.active)
        // The retired runtime does nothing, whatever still calls it.
        runBlocking { a.repository.tick(CONV_A); a.repository.flushOutbox(force = true) }
        val direct = a.repository.outbox.flush(force = true)
        assertTrue(direct.sent.isEmpty() && direct.sessionExpired)
        try { a.api.sendMessage(CONV_A, "x", SECRET_UNSENT, null, emptyList()); fail() } catch (e: ChatException) { assertTrue(e is ChatException.SessionExpired) }
        val b = checkNotNull(accounts.runtime(session, fake.client()))
        assertNotSame(a, b)
        runBlocking { b.repository.tick(CONV_A) }
        assertNothingOfA(b)
        assertEquals(emptyList<Pair<String?, String>>(), fake.posts.toList())
        // B's calls carried B's bearer only, never the token cached for A.
        assertTrue(fake.bearers.contains("Bearer spa_B"))
        val afterSwitch = fake.bearers.drop(fake.bearers.indexOf("Bearer spa_B"))
        assertTrue(afterSwitch.all { it == "Bearer spa_B" })
    }

    @Test fun `when B's identity lookup fails nothing opens, and A's saved identity is never reused`() {
        val a = aWithQueuedSend()
        session.who = "B"
        fake.identityFailsFor = setOf("B")
        assertNull(accounts.runtime(session, fake.client()))
        assertFalse(a.active)
        // A process restart with B still unidentified: still nothing.
        assertNull(ChatAccounts(files, cache).runtime(session, fake.client()))
        assertEquals(emptyList<Pair<String?, String>>(), fake.posts.toList())
        fake.identityFailsFor = emptySet()
        val b = checkNotNull(ChatAccounts(files, cache).runtime(session, fake.client()))
        runBlocking { b.repository.tick(null) }
        assertNothingOfA(b)
        assertEquals(emptyList<Pair<String?, String>>(), fake.posts.toList())
    }

    @Test fun `the same person signing in again keeps their unsent message and sends it as themselves`() {
        aWithQueuedSend()
        session.who = "A2"
        val again = checkNotNull(accounts.runtime(session, fake.client()))
        runBlocking { again.repository.flushOutbox(force = true) }
        assertEquals(listOf("Bearer spa_A2"), fake.posts.map { it.first })
        assertTrue(fake.posts.single().second.contains(SECRET_UNSENT))
    }

    @Test fun `sign-out retires chat and deletes everything it saved`() {
        val a = aWithQueuedSend()
        accounts.signOut()
        assertFalse(a.active)
        runBlocking { a.repository.flushOutbox(force = true) }
        assertEquals(emptyList<Pair<String?, String>>(), fake.posts.toList())
        assertEquals(emptyList<File>(), (files.walk() + cache.walk()).filter { it.isFile }.toList())
        session.who = null
        assertNull(accounts.runtime(session, fake.client()))
    }

    @Test fun `the token guard drops a token cached for the previous account`() {
        var account: String? = "one"; var invalidations = 0
        val guard = AccountTokenGuard({ account }, { invalidations++ })
        guard.token { }; guard.token { }
        assertEquals(1, invalidations)
        account = "two"; guard.token { }
        assertEquals(2, invalidations)
        guard.reset(); assertEquals(3, invalidations)
    }
}

/** SP-0148 S1: remote preview pictures are never fetched by the phone. */
class PreviewImageTest {
    @Test fun `only same-origin preview pictures are loaded`() {
        assertNull(ChatFormat.previewImage(null))
        assertNull(ChatFormat.previewImage("https://images.example/pixel.png"))
        assertNull(ChatFormat.previewImage("http://10.0.0.1/admin"))
        assertNull(ChatFormat.previewImage("//evil.example/x.png"))
        assertNull(ChatFormat.previewImage("/\\evil.example/x.png"))
        assertEquals("/api/v1/messaging/previews/abc/image", ChatFormat.previewImage("/api/v1/messaging/previews/abc/image"))
        val p = LinkPreview.from(JSONObject().put("url", "https://news.example/").put("title", "News").put("image_url", JSONObject.NULL)
            .put("description", JSONObject.NULL).put("site_name", JSONObject.NULL).put("status", "ready"))
        assertNull(p.imageUrl)
    }
}
