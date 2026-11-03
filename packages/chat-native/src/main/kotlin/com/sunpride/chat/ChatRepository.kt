package com.sunpride.chat

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

data class ConversationsState(val items: List<Conversation> = emptyList(), val loaded: Boolean = false,
    val offline: Boolean = false, val error: String? = null, val nextCursor: String? = null)

/** Messages of one conversation (or thread) as the screen sees them: server messages plus unsent ones. */
data class ThreadState(val messages: List<ChatMessage> = emptyList(), val pending: List<PendingSend> = emptyList(),
    val hasMore: Boolean = false, val loaded: Boolean = false, val offline: Boolean = false, val error: String? = null)

/**
 * The one place screens read from. Cache first (memory, then disk), then the network; sends go through the
 * outbox so they survive being offline or killed.
 */
class ChatRepository(
    private val api: ChatApi,
    private val cache: ChatCache,
    val outbox: Outbox,
    private val clock: () -> Long = System::currentTimeMillis,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    initialMeIds: Set<String> = emptySet(),
    private val persistMeIds: (Set<String>) -> Unit = {},
) {
    private val _conversations = MutableStateFlow(ConversationsState(items = cache.conversations(), loaded = false))
    val conversations: StateFlow<ConversationsState> = _conversations.asStateFlow()
    private val _unread = MutableStateFlow(UnreadSummary.NONE)
    val unread: StateFlow<UnreadSummary> = _unread.asStateFlow()
    private val _me = MutableStateFlow(initialMeIds)
    val myIds: StateFlow<Set<String>> = _me.asStateFlow()
    private val states = HashMap<String, MutableStateFlow<ThreadState>>()
    private val flushLock = Mutex()

    companion object {
        fun key(conversationId: String, parentId: String? = null) = if (parentId == null) conversationId else "$conversationId#$parentId"
    }

    // ---------- state plumbing ----------
    @Synchronized private fun flow(key: String): MutableStateFlow<ThreadState> = states.getOrPut(key) {
        MutableStateFlow(ThreadState(messages = cache.messages(key)))
    }
    fun state(conversationId: String, parentId: String? = null): StateFlow<ThreadState> = flow(key(conversationId, parentId)).asStateFlow()

    private fun pendingFor(conversationId: String, parentId: String?) =
        outbox.forConversation(conversationId).filter { it.parentMessageId == parentId }

    /**
     * Fold a fetched window into the state. [windowHasMore] is the server's has_more for that window; it is
     * used on the first load, or when the window does not touch what we already hold (then the old rows are
     * dropped so the timeline never has a hole in it; older rows are fetched on scroll).
     */
    private fun merge(key: String, conversationId: String, parentId: String?, incoming: List<ChatMessage>, windowHasMore: Boolean?, replaceTail: Boolean) {
        val f = flow(key)
        f.update { old ->
            val detached = replaceTail && windowHasMore == true && old.messages.isNotEmpty() && incoming.isNotEmpty() &&
                incoming.minOf { it.seq } > old.messages.maxOf { it.seq }
            val byId = LinkedHashMap<String, ChatMessage>()
            if (!detached) old.messages.forEach { byId[it.id] = it }
            incoming.forEach { byId[it.id] = it }
            // A message the server no longer lists inside the window it just returned was removed for us.
            if (replaceTail && incoming.isNotEmpty()) {
                val lo = incoming.minOf { it.seq }; val hi = incoming.maxOf { it.seq }; val ids = incoming.map { it.id }.toSet()
                byId.values.removeAll { it.seq in lo..hi && it.id !in ids }
            }
            val all = byId.values.sortedBy { it.seq }
            val more = if (windowHasMore != null && (!old.loaded || detached)) windowHasMore else old.hasMore
            old.copy(messages = all, pending = pendingFor(conversationId, parentId), hasMore = more,
                loaded = true, offline = false, error = null)
        }
        cache.putMessages(key, f.value.messages)
    }

    private fun republishPending(conversationId: String) {
        synchronized(this) { states.filterKeys { it == conversationId || it.startsWith("$conversationId#") } }.forEach { (k, f) ->
            val parent = k.substringAfter('#', "").takeIf { it.isNotEmpty() }
            f.update { it.copy(pending = pendingFor(conversationId, parent)) }
        }
    }

    private suspend fun <T> call(block: () -> T): T = withContext(io) {
        try { block() }
        catch (e: org.json.JSONException) { throw ChatException.Server(502) }
        catch (e: ClassCastException) { throw ChatException.Server(502) }
    }

    // ---------- who am I ----------
    suspend fun ensureMe() {
        if (_me.value.isNotEmpty()) return
        // `/unread` names the caller exactly; `/api/me` ids remain the fallback.
        val canonical = runCatching { call { api.unread() } }.getOrNull()?.me?.id
        val ids = (listOfNotNull(canonical) + (runCatching { call { api.myIds() } }.getOrNull() ?: emptySet())).toSet()
        if (ids.isNotEmpty()) setMe(ids)
    }
    private fun setMe(ids: Set<String>) { _me.value = ids; runCatching { persistMeIds(ids) } }
    fun isMine(m: ChatMessage) = m.author.id in _me.value

    // ---------- conversation list ----------
    suspend fun refreshConversations() {
        try {
            val page = call { api.conversations() }
            cache.putConversations(page.items)
            _conversations.value = ConversationsState(page.items, loaded = true, nextCursor = page.nextCursor)
        } catch (e: ChatException) {
            _conversations.update { it.copy(loaded = true, offline = e is ChatException.Offline, error = if (e is ChatException.Offline) null else ChatErrors.words(e)) }
        }
    }
    suspend fun loadMoreConversations() {
        val cursor = _conversations.value.nextCursor ?: return
        runCatching { call { api.conversations(cursor) } }.getOrNull()?.let { page ->
            val merged = (_conversations.value.items + page.items).distinctBy { it.id }
            cache.putConversations(merged)
            _conversations.update { it.copy(items = merged, nextCursor = page.nextCursor) }
        }
    }
    suspend fun refreshUnread() {
        runCatching { call { api.unread() } }.getOrNull()?.let { u ->
            _unread.value = u
            u.me?.let { me -> if (me.id !in _me.value) setMe(_me.value + me.id) }
        }
    }
    fun conversationById(id: String): Conversation? = _conversations.value.items.firstOrNull { it.id == id }
    private fun upsertConversation(c: Conversation) {
        _conversations.update { s -> s.copy(items = (listOf(c) + s.items.filter { it.id != c.id })) }
        cache.putConversations(_conversations.value.items)
    }

    // ---------- messages ----------
    /** Show what is saved at once, then fetch the latest 50. */
    suspend fun open(conversationId: String, parentId: String? = null) {
        flow(key(conversationId, parentId)).update { it.copy(pending = pendingFor(conversationId, parentId)) }
        refresh(conversationId, parentId)
    }

    suspend fun refresh(conversationId: String, parentId: String? = null) {
        val k = key(conversationId, parentId)
        try {
            val page = call { api.messages(conversationId, limit = ChatCache.KEEP, thread = parentId) }
            merge(k, conversationId, parentId, page.items, page.hasMore, replaceTail = true)
        } catch (e: ChatException) {
            flow(k).update { it.copy(loaded = true, offline = e is ChatException.Offline, error = if (e is ChatException.Offline) null else ChatErrors.words(e)) }
        }
    }

    suspend fun loadOlder(conversationId: String, parentId: String? = null) {
        val k = key(conversationId, parentId)
        val first = flow(k).value.messages.firstOrNull() ?: return
        try {
            val page = call { api.messages(conversationId, beforeSeq = first.seq, limit = ChatCache.KEEP, thread = parentId) }
            val f = flow(k)
            f.update { old ->
                val all = (old.messages + page.items).distinctBy { it.id }.sortedBy { it.seq }
                old.copy(messages = all, hasMore = page.hasMore, offline = false)
            }
            // The offline cache keeps only the newest 50, whatever is on screen.
            cache.putMessages(k, f.value.messages)
        } catch (e: ChatException) {
            flow(k).update { it.copy(offline = e is ChatException.Offline, error = if (e is ChatException.Offline) null else ChatErrors.words(e)) }
        }
    }

    /** Queue a message and try to send it now. Returns at once with the queued entry; the screen shows it as sending. */
    suspend fun send(conversationId: String, body: String, parentId: String?, attachments: List<LocalAttachment> = emptyList()): PendingSend {
        val p = withContext(io) { outbox.enqueue(conversationId, body, parentId, attachments) }
        republishPending(conversationId)
        flushOutbox(force = true)
        return p
    }

    suspend fun flushOutbox(force: Boolean = false) {
        flushLock.withLock {
            val r = withContext(io) { runCatching { outbox.flush(force) }.getOrNull() } ?: return
            for ((p, message) in r.sent) {
                // A message I sent names me exactly; remember it so "mine" is right even if /api/me used another id.
                if (message.author.id.isNotEmpty() && message.author.id !in _me.value) setMe(_me.value + message.author.id)
                val k = key(p.conversationId, p.parentMessageId)
                merge(k, p.conversationId, p.parentMessageId, listOf(message), null, replaceTail = false)
            }
            r.sent.map { it.first.conversationId }.distinct().forEach { republishPending(it) }
            r.failed.map { it.conversationId }.distinct().forEach { republishPending(it) }
            // Anything still waiting is shown as waiting; re-publish so attempts/failures reach the screen.
            outbox.list().map { it.conversationId }.distinct().forEach { republishPending(it) }
        }
    }
    fun retry(clientMsgId: String, conversationId: String) { outbox.retryNow(clientMsgId); republishPending(conversationId) }
    fun discard(clientMsgId: String, conversationId: String) { outbox.discard(clientMsgId); republishPending(conversationId) }

    suspend fun edit(m: ChatMessage, body: String) {
        val updated = call { api.edit(m.id, body) }
        merge(key(m.conversationId, m.parentMessageId), m.conversationId, m.parentMessageId, listOf(updated), null, false)
    }
    suspend fun delete(m: ChatMessage) {
        call { api.delete(m.id) }
        val k = key(m.conversationId, m.parentMessageId)
        flow(k).update { s -> s.copy(messages = s.messages.map { if (it.id == m.id) it.copy(body = "", deleted = true, attachments = emptyList()) else it }) }
        cache.putMessages(k, flow(k).value.messages)
    }

    /** Tap on an emoji: add yours or take it back. Shown at once, put back if the server refuses. */
    suspend fun toggleReaction(m: ChatMessage, emoji: String) {
        val k = key(m.conversationId, m.parentMessageId)
        val mine = m.reactions.firstOrNull { it.emoji == emoji }?.mine == true
        fun apply(add: Boolean) = flow(k).update { s ->
            s.copy(messages = s.messages.map { x ->
                if (x.id != m.id) x else {
                    val others = x.reactions.filter { it.emoji != emoji }
                    val cur = x.reactions.firstOrNull { it.emoji == emoji }
                    val count = (cur?.count ?: 0) + if (add) 1 else -1
                    x.copy(reactions = if (count <= 0) others else others + Reaction(emoji, count, add))
                }
            })
        }
        apply(!mine)
        try { call { if (mine) api.unreact(m.id, emoji) else api.react(m.id, emoji) } }
        catch (e: ChatException) { apply(mine); throw e }
        cache.putMessages(k, flow(k).value.messages)
    }

    /** Tell the server how far you have read; the list and badge drop to zero straight away. */
    suspend fun markRead(conversationId: String) {
        val top = flow(conversationId).value.messages.maxOfOrNull { it.seq } ?: return
        val c = conversationById(conversationId)
        if (c != null && c.unreadCount == 0 && c.mentionCount == 0) return
        try { call { api.markRead(conversationId, top) } } catch (_: ChatException) { return }
        _conversations.update { s -> s.copy(items = s.items.map { if (it.id == conversationId) it.copy(unreadCount = 0, mentionCount = 0) else it }) }
        cache.putConversations(_conversations.value.items)
        _unread.update { u ->
            val gone = u.conversations.firstOrNull { it.id == conversationId }
            if (gone == null) u else UnreadSummary(maxOf(0, u.total - gone.unreadCount), maxOf(0, u.mentions - gone.mentionCount), u.conversations.filter { it.id != conversationId }, u.me)
        }
    }

    /** Where the "New messages" divider goes: the first message after what this person had read. */
    suspend fun firstUnreadSeq(conversationId: String): Long? {
        val c = conversationById(conversationId)
        val detail = runCatching { call { api.conversation(conversationId) } }.getOrNull()
        val me = detail?.members?.firstOrNull { it.user.id in _me.value }
        if (detail != null && me != null) {
            val top = detail.conversation.lastMessage?.seq
            return if (top != null && top > me.lastReadSeq) me.lastReadSeq + 1 else null
        }
        val unread = detail?.conversation?.unreadCount ?: c?.unreadCount ?: 0
        val top = (detail?.conversation ?: c)?.lastMessage?.seq ?: return null
        return if (unread > 0) maxOf(1, top - unread + 1) else null
    }

    suspend fun detail(conversationId: String): ConversationDetail = call { api.conversation(conversationId) }

    suspend fun setMuted(conversationId: String, muted: Boolean) {
        call { api.setMuted(conversationId, muted) }
        _conversations.update { s -> s.copy(items = s.items.map { if (it.id == conversationId) it.copy(muted = muted) else it }) }
        cache.putConversations(_conversations.value.items)
    }
    suspend fun leave(conversationId: String) {
        val candidates = _me.value.filter { it.matches(Regex("[0-9a-fA-F-]{36}")) }
        if (candidates.isEmpty()) throw ChatException.Api(400, "invalid", "unknown user")
        var last: ChatException? = null
        var done = false
        for (id in candidates) {
            try { call { api.leave(conversationId, id) }; done = true; break }
            catch (e: ChatException.Api) { last = e }   // not that id: try the next one
        }
        if (!done) throw last ?: ChatException.Server(500)
        _conversations.update { s -> s.copy(items = s.items.filter { it.id != conversationId }) }
        cache.putConversations(_conversations.value.items)
    }
    suspend fun startDm(userId: String): Conversation = call { api.createDm(userId) }.also { upsertConversation(it) }
    suspend fun startGroup(userIds: List<String>, title: String?): Conversation = call { api.createGroup(userIds, title) }.also { upsertConversation(it) }
    suspend fun startChannel(title: String, topic: String?, isPrivate: Boolean): Conversation = call { api.createChannel(title, topic, isPrivate) }.also { upsertConversation(it) }
    suspend fun browseChannels(q: String): List<Conversation> = call { api.browseChannels(q) }
    suspend fun join(c: Conversation): Conversation { call { api.join(c.id) }; upsertConversation(c); return c }
    suspend fun searchPeople(q: String): List<UserLite> = call { api.searchUsers(q) }
    suspend fun searchRefs(q: String, types: List<String>): List<RefEntry> = call { api.searchRefs(q, types) }
    suspend fun searchMessages(q: String, cursor: String? = null): SearchPage = call { api.search(q, cursor) }

    /** One refresh round: unsent messages, the list, the badge and the open conversation. Never throws. */
    suspend fun tick(openConversation: String?, openThreadParent: String? = null) {
        ensureMe()
        flushOutbox(force = false)
        refreshConversations()
        refreshUnread()
        if (openConversation != null) {
            refresh(openConversation, null)
            if (openThreadParent != null) refresh(openConversation, openThreadParent)
        }
    }
}
