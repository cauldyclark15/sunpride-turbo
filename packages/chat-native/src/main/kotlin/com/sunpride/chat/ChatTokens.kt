package com.sunpride.chat

/** One piece of a message body after tokens are resolved; the UI draws chips, never raw tokens. */
sealed interface Segment {
    data class Text(val text: String) : Segment
    data class UserMention(val userId: String, val label: String) : Segment
    data class ObjectChip(val type: String, val id: String, val label: String, val entry: RefEntry?) : Segment
    data object Channel : Segment
}

/** Canonical body tokens: `<@user:UUID>`, `<#TYPE:ID>`, `<!channel>`. */
object ChatTokens {
    /** Ref types the server accepts (contract "Object references"). `user` is mentioned with `<@user:…>`. */
    val OBJECT_TYPES = listOf("outlet", "product", "customer", "issue", "order", "visit", "territory", "route", "van_trip")
    const val CHANNEL = "<!channel>"
    const val MAX_BODY = 4000
    private val TOKEN = Regex("<@user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})>|<#([a-z_]+):([A-Za-z0-9_.:-]{1,80})>|<!channel>")

    fun userToken(userId: String) = "<@user:$userId>"
    fun objectToken(type: String, id: String) = "<#$type:$id>"

    /** Plain business words for a ref type; never the snake_case type name. */
    fun typeLabel(type: String): String = when (type) {
        "user" -> "Person"; "outlet" -> "Store"; "product" -> "Item"; "customer" -> "Customer"; "issue" -> "Issue"
        "order" -> "Order"; "visit" -> "Visit"; "territory" -> "Territory"; "route" -> "Route"; "van_trip" -> "Van trip"
        else -> "Item"
    }

    fun parse(body: String, refs: List<RefEntry> = emptyList(), people: Map<String, String> = emptyMap()): List<Segment> {
        val byKey = refs.associateBy { it.type + ":" + it.id.lowercase() }
        val out = ArrayList<Segment>()
        var last = 0
        for (m in TOKEN.findAll(body)) {
            if (m.range.first > last) out.add(Segment.Text(body.substring(last, m.range.first)))
            val g = m.groupValues
            when {
                m.value == CHANNEL -> out.add(Segment.Channel)
                g[1].isNotEmpty() -> {
                    val entry = byKey["user:" + g[1].lowercase()]
                    val name = entry?.takeIf { !it.restricted && !it.missing && it.title.isNotBlank() }?.title ?: people[g[1].lowercase()] ?: people[g[1]]
                    out.add(Segment.UserMention(g[1], name ?: "someone"))
                }
                else -> {
                    val entry = byKey[g[2] + ":" + g[3].lowercase()] ?: byKey[g[2] + ":" + g[3]]
                    val label = when {
                        entry == null -> typeLabel(g[2])
                        entry.restricted -> "Restricted item"
                        entry.missing -> "Removed " + typeLabel(g[2]).lowercase()
                        else -> entry.title.ifBlank { typeLabel(g[2]) }
                    }
                    out.add(Segment.ObjectChip(g[2], g[3], label, entry))
                }
            }
            last = m.range.last + 1
        }
        if (last < body.length) out.add(Segment.Text(body.substring(last)))
        return out
    }

    /** Readable one-line text: `@Maria`, `Store name`, `@channel`. Used for previews, notifications and Copy. */
    fun plain(body: String, refs: List<RefEntry> = emptyList(), people: Map<String, String> = emptyMap()): String =
        parse(body, refs, people).joinToString("") {
            when (it) {
                is Segment.Text -> it.text
                is Segment.UserMention -> "@" + it.label
                is Segment.ObjectChip -> it.label
                Segment.Channel -> "@channel"
            }
        }

    /** Distinct object chips of a body in order, for the thumbnail cards under a message. */
    fun objectChips(body: String, refs: List<RefEntry>): List<Segment.ObjectChip> =
        parse(body, refs).filterIsInstance<Segment.ObjectChip>().distinctBy { it.type + ":" + it.id }

    /** Up to 3 http(s) URLs in plain text, as the server extracts them for previews. */
    private val URL = Regex("https?://[^\\s<>\"']+")
    fun urls(body: String): List<String> = URL.findAll(body).map { it.value.trimEnd('.', ',', ')', ';', '!', '?') }.distinct().take(3).toList()
}

/**
 * What a person is typing. They see `@Maria Santos` and `Main Street Store`; the canonical tokens are
 * substituted only when the body is built for sending.
 */
class ComposerDraft private constructor(val text: String, private val tokens: List<Pair<String, String>>) {
    constructor() : this("", emptyList())

    fun withText(newText: String): ComposerDraft = ComposerDraft(newText, tokens.filter { newText.contains(it.first) })

    /** An active `@query` or `#query` right before the cursor, if any. */
    data class Trigger(val char: Char, val query: String, val start: Int, val end: Int)
    fun triggerAt(cursor: Int): Trigger? {
        val c = cursor.coerceIn(0, text.length)
        var i = c - 1
        while (i >= 0 && !text[i].isWhitespace() && text[i] != '@' && text[i] != '#') i--
        if (i < 0 || (text[i] != '@' && text[i] != '#')) return null
        if (i > 0 && !text[i - 1].isWhitespace()) return null
        val query = text.substring(i + 1, c)
        if (query.length > 30) return null
        return Trigger(text[i], query, i, c)
    }

    private fun unique(label: String, token: String): String {
        var candidate = label; var n = 2
        while (tokens.any { it.first == candidate && it.second != token }) { candidate = "$label ($n)"; n++ }
        return candidate
    }

    /** Replaces the trigger with a visible label and remembers its token. Returns the new draft and cursor. */
    fun insert(trigger: Trigger, label: String, token: String): Pair<ComposerDraft, Int> {
        val shown = unique(label, token)
        val before = text.substring(0, trigger.start)
        val after = text.substring(trigger.end)
        val spacer = if (after.startsWith(" ")) "" else " "
        val next = before + shown + spacer + after
        return ComposerDraft(next, tokens.filter { next.contains(it.first) } + (shown to token)) to (before.length + shown.length + 1)
    }

    fun userLabel(name: String) = "@$name"
    fun hasContent(): Boolean = text.isNotBlank()

    /** The body to send: visible labels swapped for tokens, longest label first so one never eats another. */
    fun toBody(): String {
        val body = text.trim()
        val byLength = tokens.sortedByDescending { it.first.length }
        val out = StringBuilder()
        var i = 0
        while (i < body.length) {
            val hit = byLength.firstOrNull { body.startsWith(it.first, i) }
            if (hit != null) { out.append(hit.second); i += hit.first.length } else { out.append(body[i]); i++ }
        }
        return out.toString()
    }

    /** Labels currently in the text, so the field can highlight them. */
    fun labels(): List<String> = tokens.map { it.first }

    companion object {
        /** Start editing an existing message: tokens become readable labels again. */
        fun fromBody(body: String, refs: List<RefEntry>): ComposerDraft {
            var draft = ComposerDraft()
            val sb = StringBuilder()
            val tokens = ArrayList<Pair<String, String>>()
            for (seg in ChatTokens.parse(body, refs)) when (seg) {
                is Segment.Text -> sb.append(seg.text)
                is Segment.UserMention -> { val l = "@" + seg.label; sb.append(l); tokens.add(l to ChatTokens.userToken(seg.userId)) }
                is Segment.ObjectChip -> { sb.append(seg.label); tokens.add(seg.label to ChatTokens.objectToken(seg.type, seg.id)) }
                Segment.Channel -> { sb.append("@channel"); tokens.add("@channel" to ChatTokens.CHANNEL) }
            }
            draft = ComposerDraft(sb.toString(), tokens.distinct())
            return draft
        }
    }
}
