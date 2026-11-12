package com.sunpride.chat

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

class ChatTokensTest {
    private val maria = RefEntry("user", Fx.MARIA, "Maria Santos", null, null, null, "ok")
    private val store = RefEntry("outlet", "o-1", "Main Street Store", "Cebu City", "https://x/t.jpg", "/stores/o-1", "ok")
    private val secret = RefEntry("order", "ord-9", "Restricted item", null, null, "/orders/ord-9", "restricted")

    @Test fun `user mention object and channel tokens become chips and never raw text`() {
        val body = "Hi <@user:${Fx.MARIA}> see <#outlet:o-1> and <!channel> please"
        val segs = ChatTokens.parse(body, listOf(maria, store))
        assertEquals(7, segs.size)
        assertTrue(segs[1] is Segment.UserMention)
        assertEquals("Maria Santos", (segs[1] as Segment.UserMention).label)
        val chip = segs[3] as Segment.ObjectChip
        assertEquals("Main Street Store", chip.label); assertEquals("https://x/t.jpg", chip.entry?.thumbUrl)
        assertSame(Segment.Channel, segs[5])
        val plain = ChatTokens.plain(body, listOf(maria, store))
        assertEquals("Hi @Maria Santos see Main Street Store and @channel please", plain)
        assertFalse(plain.contains("<") || plain.contains(Fx.MARIA) || plain.contains("o-1"))
    }

    @Test fun `unresolved and restricted refs show words, not ids`() {
        val plain = ChatTokens.plain("<@user:${Fx.BOT}> <#product:sku-77> <#order:ord-9> <#route:r1>", listOf(secret))
        assertEquals("@someone Item Restricted item Route", plain)
    }

    @Test fun `unknown token shapes stay as plain text and malformed ones are not chips`() {
        val segs = ChatTokens.parse("<@user:not-a-uuid> <#Bad Type:1> <!here>")
        assertEquals(1, segs.size); assertTrue(segs[0] is Segment.Text)
    }

    @Test fun `object chips are distinct and in order`() {
        val chips = ChatTokens.objectChips("<#outlet:o-1> and again <#outlet:o-1> then <#product:p-2>", listOf(store))
        assertEquals(listOf("outlet:o-1", "product:p-2"), chips.map { it.type + ":" + it.id })
    }

    @Test fun `urls are found the way the server finds them, max three`() {
        val urls = ChatTokens.urls("a https://a.test/x. b (http://b.test/y) c https://c.test d https://d.test e https://a.test/x")
        assertEquals(listOf("https://a.test/x", "http://b.test/y", "https://c.test"), urls)
    }

    @Test fun `composer shows names and sends canonical tokens`() {
        var d = ComposerDraft().withText("Hello @mar")
        val t = d.triggerAt(10)!!
        assertEquals('@', t.char); assertEquals("mar", t.query)
        val (d2, cursor) = d.insert(t, "@Maria Santos", ChatTokens.userToken(Fx.MARIA))
        assertEquals("Hello @Maria Santos ", d2.text); assertEquals(d2.text.length, cursor)
        val t2 = d2.withText(d2.text + "check #main").let { it to it.triggerAt(it.text.length)!! }
        assertEquals('#', t2.second.char)
        val (d3, _) = t2.first.insert(t2.second, "Main Street Store", ChatTokens.objectToken("outlet", "o-1"))
        assertEquals("Hello <@user:${Fx.MARIA}> check <#outlet:o-1>", d3.toBody())
        assertFalse(d3.text.contains("<"))
    }

    @Test fun `deleting a chip's text drops its token and no trigger fires inside a word`() {
        val (d, _) = ComposerDraft().withText("@ma").let { it.insert(it.triggerAt(3)!!, "@Maria", "<@user:${Fx.MARIA}>") }
        assertEquals("<@user:${Fx.MARIA}>", d.toBody())
        val gone = d.withText("hello")
        assertEquals("hello", gone.toBody())
        assertNull(ComposerDraft().withText("mail me at a@b").triggerAt(14))
    }

    @Test fun `two people with the same name get distinct visible labels`() {
        val a = "<@user:${Fx.MARIA}>"; val b = "<@user:${Fx.BOT}>"
        var d = ComposerDraft().withText("@m")
        d = d.insert(d.triggerAt(2)!!, "@Maria", a).first
        d = d.withText(d.text + "@m")
        d = d.insert(d.triggerAt(d.text.length)!!, "@Maria", b).first
        assertEquals("<@user:${Fx.MARIA}> <@user:${Fx.BOT}>", d.toBody())
        assertNotEquals(d.labels()[0], d.labels()[1])
    }

    @Test fun `editing a message turns its tokens back into readable names and round-trips`() {
        val body = "Ping <@user:${Fx.MARIA}> about <#outlet:o-1>"
        val d = ComposerDraft.fromBody(body, listOf(maria, store))
        assertEquals("Ping @Maria Santos about Main Street Store", d.text)
        assertEquals(body, d.toBody())
    }

    @Test fun `a label that looks like part of a token cannot corrupt it`() {
        val (d, _) = ComposerDraft().withText("#x").let { it.insert(it.triggerAt(2)!!, "outlet", "<#outlet:o-1>") }
        assertEquals("<#outlet:o-1>", d.toBody())
    }
}

class ChatFormatTest {
    private val zone = ZoneId.of("Asia/Manila")
    private val en = Locale.US
    // 2026-11-03 10:00 in Manila
    private val now = java.time.ZonedDateTime.of(2026, 11, 3, 10, 0, 0, 0, zone).toInstant().toEpochMilli()
    private fun at(day: Int, h: Int, mi: Int = 0) = java.time.ZonedDateTime.of(2026, 11, day, h, mi, 0, 0, zone).toInstant().toEpochMilli()

    @Test fun `day labels and list times`() {
        assertEquals("Today", ChatFormat.dayLabel(at(3, 1), now, zone, en))
        assertEquals("Yesterday", ChatFormat.dayLabel(at(2, 23), now, zone, en))
        assertEquals("Friday, Oct 30", ChatFormat.dayLabel(java.time.ZonedDateTime.of(2026, 10, 30, 9, 0, 0, 0, zone).toInstant().toEpochMilli(), now, zone, en))
        assertEquals("9:05 AM", ChatFormat.listTime(at(3, 9, 5), now, zone, en))
        assertEquals("Yesterday", ChatFormat.listTime(at(2, 9), now, zone, en))
        assertEquals("Fri", ChatFormat.listTime(java.time.ZonedDateTime.of(2026, 10, 30, 9, 0, 0, 0, zone).toInstant().toEpochMilli(), now, zone, en))
        assertEquals("", ChatFormat.listTime(0, now, zone, en))
    }

    @Test fun `initials sizes and titles in plain words`() {
        assertEquals("MS", ChatFormat.initials("Maria Santos")); assertEquals("B", ChatFormat.initials("bot")); assertEquals("?", ChatFormat.initials(" "))
        assertEquals("512 B", ChatFormat.fileSize(512)); assertEquals("2 KB", ChatFormat.fileSize(2048)); assertEquals("1.5 MB", ChatFormat.fileSize(1572864))
        val dm = Conversation.from(Fx.conversation())
        assertEquals("Maria Santos", ChatFormat.title(dm, setOf(Fx.ME)))
        val ch = Conversation.from(Fx.conversation(kind = "channel", title = "sales-cebu"))
        assertEquals("# sales-cebu", ChatFormat.title(ch, setOf(Fx.ME)))
    }

    @Test fun `sections put channels dms groups and AI users apart`() {
        val me = setOf(Fx.ME)
        assertEquals(ConversationSection.CHANNELS, ChatFormat.sectionOf(Conversation.from(Fx.conversation(kind = "channel", title = "x")), me))
        assertEquals(ConversationSection.DIRECT, ChatFormat.sectionOf(Conversation.from(Fx.conversation()), me))
        assertEquals(ConversationSection.GROUPS, ChatFormat.sectionOf(Conversation.from(Fx.conversation(kind = "group")), me))
        val ai = Fx.conversation().put("members_preview", JSONArray().put(Fx.user(Fx.ME, "Me")).put(Fx.user(Fx.BOT, "Phantasm", true)))
        assertEquals(ConversationSection.AI, ChatFormat.sectionOf(Conversation.from(ai), me))
    }

    @Test fun `last line never shows tokens`() {
        // MessageLite carries no refs: people come from the members preview, objects show their type word.
        val last = Fx.lite(Fx.message("m1", 1, "see <#outlet:o-1> with <@user:${Fx.MARIA}>"))
        val c = Conversation.from(Fx.conversation(kind = "group", last = last))
        assertEquals("Maria: see Store with @Maria Santos", ChatFormat.lastLine(c, setOf(Fx.ME)))
        val files = Conversation.from(Fx.conversation(kind = "group", last = Fx.lite(Fx.message("m2", 2, ""))))
        assertEquals("Maria: Sent an attachment", ChatFormat.lastLine(files, setOf(Fx.ME)))
        val gone = Conversation.from(Fx.conversation(last = Fx.lite(Fx.message("m3", 3, "").put("deleted", true))))
        assertEquals("This message was deleted", ChatFormat.lastLine(gone, setOf(Fx.ME)))
    }

    @Test fun `MessageLite reads exactly the API's last_message fields`() {
        val o = Fx.lite(Fx.message("m1", 4, "hi"))
        assertEquals(listOf("author", "body", "created_at", "deleted", "id", "seq"), o.keys().asSequence().toList().sorted())
        val m = MessageLite.from(o)
        assertEquals(MessageLite("m1", 4, UserLite(Fx.MARIA, "Maria Santos", null, false), "hi", false, "2026-11-03T01:00:00.000Z"), m)
        assertEquals(m, MessageLite.from(m.toJson()))
    }
}

class MessageLayoutTest {
    private val zone = ZoneId.of("UTC")
    private val me = setOf(Fx.ME)
    private fun m(id: String, seq: Long, author: String, at: String) =
        ChatMessage.from(Fx.message(id, seq, "text $id", author, if (author == Fx.ME) "Me" else "Maria", at = at))
    private val now = java.time.Instant.parse("2026-11-03T12:00:00Z").toEpochMilli()

    @Test fun `bubbles group by author within five minutes and split by day`() {
        val rows = MessageLayout.build(listOf(
            m("a", 1, Fx.MARIA, "2026-11-02T23:58:00Z"), m("b", 2, Fx.MARIA, "2026-11-02T23:59:00Z"),
            m("c", 3, Fx.MARIA, "2026-11-03T00:01:00Z"), m("d", 4, Fx.ME, "2026-11-03T00:02:00Z"),
            m("e", 5, Fx.MARIA, "2026-11-03T00:03:00Z"), m("f", 6, Fx.MARIA, "2026-11-03T00:20:00Z")),
            emptyList(), me, null, now, zone, Locale.US)
        val shape = rows.map { when (it) { is ChatRow.Day -> "D:" + it.label; is ChatRow.Msg -> (if (it.showHeader) "H" else "-") + it.message.id + (if (it.mine) "*" else ""); else -> "?" } }
        assertEquals(listOf("D:Yesterday", "Ha", "-b", "D:Today", "Hc", "Hd*", "He", "Hf"), shape)
    }

    @Test fun `the unread divider sits before the first unread message from someone else`() {
        val rows = MessageLayout.build(listOf(m("a", 1, Fx.MARIA, "2026-11-03T01:00:00Z"), m("b", 2, Fx.ME, "2026-11-03T01:01:00Z"),
            m("c", 3, Fx.MARIA, "2026-11-03T01:02:00Z"), m("d", 4, Fx.MARIA, "2026-11-03T01:02:30Z")), emptyList(), me, 3, now, zone, Locale.US)
        val i = rows.indexOfFirst { it is ChatRow.UnreadDivider }
        assertEquals(2, (rows[i] as ChatRow.UnreadDivider).count)
        assertEquals("c", (rows[i + 1] as ChatRow.Msg).message.id)
        assertTrue((rows[i + 1] as ChatRow.Msg).showHeader)
        assertTrue(MessageLayout.build(listOf(m("a", 1, Fx.MARIA, "2026-11-03T01:00:00Z")), emptyList(), me, null, now, zone).none { it is ChatRow.UnreadDivider })
    }

    @Test fun `unsent messages come last in the order they were sent`() {
        val p1 = PendingSend("c1", Fx.CONV, "one", null, emptyList(), now, 1); val p2 = PendingSend("c2", Fx.CONV, "two", null, emptyList(), now + 1000, 2)
        val rows = MessageLayout.build(listOf(m("a", 1, Fx.ME, "2026-11-03T11:59:00Z")), listOf(p2, p1), me, null, now, zone)
        assertEquals(listOf("c1", "c2"), rows.filterIsInstance<ChatRow.Sending>().map { it.send.clientMsgId })
        assertFalse(rows.filterIsInstance<ChatRow.Sending>().first().showHeader)
    }
}

class ChatLaunchTest {
    @Test fun `a notification tap opens only a conversation id, once`() {
        assertFalse(ChatLaunch.accept("not-a-conversation"))
        assertFalse(ChatLaunch.accept(null))
        assertTrue(ChatLaunch.accept(Fx.CONV))
        assertEquals(Fx.CONV, ChatLaunch.pending.value)
        ChatLaunch.clear("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
        assertEquals(Fx.CONV, ChatLaunch.pending.value)
        ChatLaunch.clear(Fx.CONV)
        assertNull(ChatLaunch.pending.value)
    }

    @Test fun `unsent messages survive leaving the screen and restarting the app`() {
        val dir = java.nio.file.Files.createTempDirectory("drafts").toFile()
        val file = java.io.File(dir, "drafts.json")
        var clock = 1_000L
        val store = DraftStore(file) { clock }
        val trigger = ComposerDraft().withText("Hi @Lo").triggerAt(6)!!
        val (mention, _) = ComposerDraft().withText("Hi @Lo").insert(trigger, "@Loren", ChatTokens.userToken("u1"))
        val withText = mention.withText(mention.text + " please check the price list")
        store["conv:1"] = withText
        store["conv:1:thread:9"] = ComposerDraft().withText("reply in thread")
        store["conv:2"] = ComposerDraft().withText("gone").withText("  ")
        store.flush()
        val reopened = DraftStore(file) { clock }
        assertEquals(withText.text, reopened["conv:1"]?.text)
        assertEquals(withText.toBody(), reopened["conv:1"]?.toBody())
        assertEquals("reply in thread", reopened["conv:1:thread:9"]?.text)
        assertNull(reopened["conv:2"])
        reopened.remove("conv:1"); reopened.flush()
        assertNull(DraftStore(file) { clock }["conv:1"])
        clock += DraftStore.MAX_AGE_MS + 1
        assertNull(DraftStore(file) { clock }["conv:1:thread:9"])
        dir.deleteRecursively()
        store["conv:3"] = ComposerDraft().withText("after sign-out"); store.flush()
        assertFalse(dir.exists())
    }
}
