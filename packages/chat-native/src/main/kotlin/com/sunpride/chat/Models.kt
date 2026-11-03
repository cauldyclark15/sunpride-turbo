package com.sunpride.chat

import org.json.JSONArray
import org.json.JSONObject
import java.time.OffsetDateTime

/*
 * Wire models for the v2 messaging contract (docs/architecture/MESSAGING_V2.md).
 * Every class reads from, and writes back to, the SAME JSON shape the server sends, so the on-disk
 * cache is parsed by exactly the code that parses network responses.
 */

internal fun JSONObject.str(key: String): String? = if (!has(key) || isNull(key)) null else optString(key).takeIf { it.isNotEmpty() || has(key) }
internal fun JSONObject.long(key: String): Long? = if (!has(key) || isNull(key)) null else optLong(key)
internal fun JSONObject.int(key: String): Int? = if (!has(key) || isNull(key)) null else optInt(key)
internal fun JSONObject.obj(key: String): JSONObject? = if (isNull(key)) null else optJSONObject(key)
internal fun JSONObject.arr(key: String): JSONArray = if (isNull(key)) JSONArray() else optJSONArray(key) ?: JSONArray()
internal fun <T> JSONArray.mapObjects(f: (JSONObject) -> T): List<T> =
    (0 until length()).mapNotNull { optJSONObject(it)?.let(f) }
internal fun JSONObject.putNullable(key: String, v: Any?): JSONObject = put(key, v ?: JSONObject.NULL)

/** `2026-11-03T08:30:00.000Z` → epoch millis; 0 when absent or malformed (never throws). */
fun parseIsoMillis(iso: String?): Long = try {
    if (iso.isNullOrBlank()) 0L else OffsetDateTime.parse(iso).toInstant().toEpochMilli()
} catch (_: Exception) { 0L }

data class UserLite(val id: String, val displayName: String, val avatarUrl: String?, val isAgent: Boolean, val roleLabel: String? = null) {
    fun toJson(): JSONObject = JSONObject().put("id", id).put("display_name", displayName).putNullable("avatar_url", avatarUrl)
        .put("is_agent", isAgent).putNullable("role_label", roleLabel)
    companion object {
        fun from(o: JSONObject) = UserLite(o.getString("id"), o.str("display_name") ?: "Someone", o.str("avatar_url"),
            o.optBoolean("is_agent", false), o.str("role_label"))
    }
}

data class Member(val user: UserLite, val role: String, val lastReadSeq: Long) {
    fun toJson(): JSONObject = user.toJson().put("role", role).put("last_read_seq", lastReadSeq)
    companion object { fun from(o: JSONObject) = Member(UserLite.from(o), o.str("role") ?: "member", o.optLong("last_read_seq", 0)) }
}

/**
 * A conversation row's `last_message`, exactly as the API sends it: `{id, seq, author, body, created_at, deleted}`.
 * No refs or attachments; a deleted message has an empty body, and a live empty body means files only.
 */
data class MessageLite(val id: String?, val seq: Long?, val author: UserLite?, val body: String, val deleted: Boolean,
    val createdAt: String?) {
    fun toJson(): JSONObject = JSONObject().putNullable("id", id).putNullable("seq", seq).putNullable("author", author?.toJson())
        .put("body", body).putNullable("created_at", createdAt).put("deleted", deleted)
    companion object {
        fun from(o: JSONObject) = MessageLite(o.str("id"), o.long("seq"), o.obj("author")?.let(UserLite::from),
            o.str("body") ?: "", o.optBoolean("deleted", false), o.str("created_at"))
    }
}

data class Conversation(
    val id: String, val kind: String, val title: String?, val topic: String?, val isPrivate: Boolean,
    val membersPreview: List<UserLite>, val memberCount: Int, val unreadCount: Int, val mentionCount: Int,
    val lastMessage: MessageLite?, val muted: Boolean, val updatedAt: String?,
) {
    val isDm get() = kind == "dm"
    val isChannel get() = kind == "channel"
    /** A direct chat with an AI user, or any chat that includes one besides the viewer's own side. */
    val hasAgent get() = membersPreview.any { it.isAgent }
    fun toJson(): JSONObject = JSONObject().put("id", id).put("kind", kind).putNullable("title", title).putNullable("topic", topic)
        .put("is_private", isPrivate).put("members_preview", JSONArray(membersPreview.map { it.toJson() }))
        .put("member_count", memberCount).put("unread_count", unreadCount).put("mention_count", mentionCount)
        .putNullable("last_message", lastMessage?.toJson()).put("muted", muted).putNullable("updated_at", updatedAt)
    companion object {
        fun from(o: JSONObject) = Conversation(o.getString("id"), o.str("kind") ?: "channel", o.str("title"), o.str("topic"),
            o.optBoolean("is_private", false), o.arr("members_preview").mapObjects(UserLite::from),
            o.optInt("member_count", 0), o.optInt("unread_count", 0), o.optInt("mention_count", 0),
            o.obj("last_message")?.let(MessageLite::from), o.optBoolean("muted", false), o.str("updated_at"))
    }
}

data class ConversationDetail(val conversation: Conversation, val members: List<Member>) {
    companion object {
        fun from(o: JSONObject) = ConversationDetail(Conversation.from(o), o.arr("members").mapObjects(Member::from))
    }
}

data class RefEntry(val type: String, val id: String, val title: String, val subtitle: String?, val thumbUrl: String?,
    val href: String?, val access: String) {
    val restricted get() = access == "restricted"
    val missing get() = access == "missing"
    fun toJson(): JSONObject = JSONObject().put("type", type).put("id", id).put("title", title).putNullable("subtitle", subtitle)
        .putNullable("thumb_url", thumbUrl).putNullable("href", href).put("access", access)
    companion object {
        fun from(o: JSONObject) = RefEntry(o.getString("type"), o.getString("id"), o.str("title") ?: "", o.str("subtitle"),
            o.str("thumb_url"), o.str("href"), o.str("access") ?: "ok")
    }
}

data class Attachment(val id: String, val name: String, val mime: String, val bytes: Long, val width: Int?, val height: Int?,
    val url: String, val thumbUrl: String?, val kind: String) {
    val isImage get() = kind == "image"
    fun toJson(): JSONObject = JSONObject().put("id", id).put("name", name).put("mime", mime).put("bytes", bytes)
        .putNullable("width", width).putNullable("height", height).put("url", url).putNullable("thumb_url", thumbUrl).put("kind", kind)
    companion object {
        fun from(o: JSONObject): Attachment {
            val mime = o.str("mime") ?: "application/octet-stream"
            return Attachment(o.getString("id"), o.str("name") ?: "File", mime, o.optLong("bytes", 0), o.int("width"), o.int("height"),
                o.str("url") ?: "", o.str("thumb_url"), o.str("kind") ?: if (mime.startsWith("image/")) "image" else "file")
        }
    }
}

data class LinkPreview(val url: String, val title: String?, val description: String?, val imageUrl: String?,
    val siteName: String?, val status: String) {
    val ready get() = status == "ready" || status == "ok" || (title != null && status != "failed" && status != "pending")
    fun toJson(): JSONObject = JSONObject().put("url", url).putNullable("title", title).putNullable("description", description)
        .putNullable("image_url", imageUrl).putNullable("site_name", siteName).put("status", status)
    companion object {
        fun from(o: JSONObject) = LinkPreview(o.str("url") ?: "", o.str("title"), o.str("description"), o.str("image_url"),
            o.str("site_name"), o.str("status") ?: "pending")
    }
}

data class Reaction(val emoji: String, val count: Int, val mine: Boolean) {
    fun toJson(): JSONObject = JSONObject().put("emoji", emoji).put("count", count).put("mine", mine)
    companion object { fun from(o: JSONObject) = Reaction(o.getString("emoji"), o.optInt("count", 0), o.optBoolean("mine", false)) }
}

data class ChatMessage(
    val id: String, val conversationId: String, val seq: Long, val author: UserLite, val body: String,
    val parentMessageId: String?, val replyCount: Int, val lastReplyAt: String?, val attachments: List<Attachment>,
    val refs: List<RefEntry>, val mentionsMe: Boolean, val reactions: List<Reaction>, val links: List<LinkPreview>,
    val edited: Boolean, val deleted: Boolean, val createdAt: String,
) {
    val createdAtMillis: Long get() = parseIsoMillis(createdAt)
    fun toJson(): JSONObject = JSONObject().put("id", id).put("conversation_id", conversationId).put("seq", seq)
        .put("author", author.toJson()).put("body", body).putNullable("parent_message_id", parentMessageId)
        .put("reply_count", replyCount).putNullable("last_reply_at", lastReplyAt)
        .put("attachments", JSONArray(attachments.map { it.toJson() })).put("refs", JSONArray(refs.map { it.toJson() }))
        .put("mentions_me", mentionsMe).put("reactions", JSONArray(reactions.map { it.toJson() }))
        .put("links", JSONArray(links.map { it.toJson() })).put("edited", edited).put("deleted", deleted).put("created_at", createdAt)
    companion object {
        fun from(o: JSONObject) = ChatMessage(
            o.getString("id"), o.str("conversation_id") ?: "", o.optLong("seq", 0), UserLite.from(o.getJSONObject("author")),
            o.str("body") ?: "", o.str("parent_message_id"), o.optInt("reply_count", 0), o.str("last_reply_at"),
            o.arr("attachments").mapObjects(Attachment::from), o.arr("refs").mapObjects(RefEntry::from),
            o.optBoolean("mentions_me", false), o.arr("reactions").mapObjects(Reaction::from),
            o.arr("links").mapObjects(LinkPreview::from), o.optBoolean("edited", false), o.optBoolean("deleted", false),
            o.str("created_at") ?: "")
    }
}

data class MessagePage(val items: List<ChatMessage>, val hasMore: Boolean)
data class SendResult(val message: ChatMessage, val replayed: Boolean)
data class ConversationPage(val items: List<Conversation>, val nextCursor: String?)
data class SearchHit(val message: ChatMessage, val conversationId: String, val conversationTitle: String?, val conversationKind: String?)
data class SearchPage(val items: List<SearchHit>, val nextCursor: String?)
data class UnreadConversation(val id: String, val unreadCount: Int, val mentionCount: Int)
/** `GET /unread` `me`: the caller's own chat identity (`users.id`), the canonical "me". */
data class ChatMe(val id: String, val displayName: String)
data class UnreadSummary(val total: Int, val mentions: Int, val conversations: List<UnreadConversation>, val me: ChatMe? = null) {
    companion object {
        val NONE = UnreadSummary(0, 0, emptyList())
        fun from(o: JSONObject) = UnreadSummary(o.optInt("total", 0), o.optInt("mentions", 0),
            o.arr("conversations").mapObjects { UnreadConversation(it.getString("id"), it.optInt("unread_count", 0), it.optInt("mention_count", 0)) },
            o.obj("me")?.let { m -> m.str("id")?.takeIf { it.isNotBlank() }?.let { ChatMe(it, m.str("display_name") ?: "") } })
    }
}
data class ClaimedUpload(val attachmentId: String, val uploadUrl: String, val expiresAt: String?)
