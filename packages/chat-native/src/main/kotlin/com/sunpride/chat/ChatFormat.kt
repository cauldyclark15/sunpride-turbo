package com.sunpride.chat

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Times and names in plain words. Pure, so it is unit-tested with a fixed zone and clock. */
object ChatFormat {
    /**
     * SP-0148: a link preview picture is loaded only from our own API (a same-origin path). A remote `og:image`
     * would be fetched by the phone outside the server's pinned, redirect-checked fetcher, so it is never loaded.
     */
    fun previewImage(url: String?): String? = url?.takeIf { it.startsWith("/") && !it.startsWith("//") && '\\' !in it }

    fun timeOfDay(ms: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String =
        DateTimeFormatter.ofPattern("h:mm a", locale).withZone(zone).format(Instant.ofEpochMilli(ms))

    fun dayLabel(ms: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val day = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        return when {
            day == today -> "Today"
            day == today.minusDays(1) -> "Yesterday"
            day.year == today.year -> DateTimeFormatter.ofPattern("EEEE, MMM d", locale).format(day)
            else -> DateTimeFormatter.ofPattern("MMM d, yyyy", locale).format(day)
        }
    }

    /** Right-hand time on a conversation row. */
    fun listTime(ms: Long, nowMs: Long, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        if (ms <= 0) return ""
        val day: LocalDate = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val today: LocalDate = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
        val age = java.time.temporal.ChronoUnit.DAYS.between(day, today)
        return when {
            age <= 0 -> timeOfDay(ms, zone, locale)
            age == 1L -> "Yesterday"
            age < 7 -> DateTimeFormatter.ofPattern("EEE", locale).format(day)
            day.year == today.year -> DateTimeFormatter.ofPattern("MMM d", locale).format(day)
            else -> DateTimeFormatter.ofPattern("MMM d, yyyy", locale).format(day)
        }
    }

    fun initials(name: String): String {
        val parts = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        return when {
            parts.isEmpty() -> "?"
            parts.size == 1 -> parts[0].take(1).uppercase()
            else -> (parts.first().take(1) + parts.last().take(1)).uppercase()
        }
    }

    fun fileSize(bytes: Long): String = when {
        bytes < 1024 -> "$bytes B"
        bytes < 1024 * 1024 -> "%.0f KB".format(Locale.US, bytes / 1024.0)
        else -> "%.1f MB".format(Locale.US, bytes / 1048576.0)
    }

    /** Conversation title in words: the saved title, else the other people, else a plain fallback. */
    fun title(c: Conversation, meIds: Set<String>): String {
        c.title?.takeIf { it.isNotBlank() }?.let { return if (c.isChannel) "# $it" else it }
        val others = c.membersPreview.filter { it.id !in meIds }.map { it.displayName }
        return when {
            others.isEmpty() -> if (c.isChannel) "Channel" else "Conversation"
            c.memberCount > others.size + 1 && others.size >= 3 -> others.take(3).joinToString(", ") + " and ${c.memberCount - 1 - 3} more"
            else -> others.joinToString(", ")
        }
    }

    fun sectionOf(c: Conversation, meIds: Set<String>): ConversationSection = when {
        c.isChannel -> ConversationSection.CHANNELS
        c.isDm && c.membersPreview.any { it.isAgent && it.id !in meIds } -> ConversationSection.AI
        c.isDm -> ConversationSection.DIRECT
        else -> ConversationSection.GROUPS
    }

    fun lastLine(c: Conversation, meIds: Set<String>): String {
        val m = c.lastMessage ?: return "No messages yet"
        if (m.deleted) return "This message was deleted"
        // MessageLite has no refs: name mentioned people from the members preview and the author.
        val people = (c.membersPreview + listOfNotNull(m.author)).associate { it.id to it.displayName }
        val text = ChatTokens.plain(m.body, emptyList(), people).replace('\n', ' ').trim()
        val who = m.author?.let { if (it.id in meIds) "You" else it.displayName.substringBefore(' ') }
        val body = text.ifEmpty { "Sent an attachment" }
        return if (c.isDm && who != "You" || who == null) body else "$who: $body"
    }
}

enum class ConversationSection(val title: String) {
    CHANNELS("Channels"), DIRECT("Direct messages"), GROUPS("Groups"), AI("AI users")
}

/** One row on screen: day labels, the unread divider, and message bubbles grouped by author. */
sealed interface ChatRow {
    val key: String
    data class Day(val label: String, override val key: String) : ChatRow
    data class UnreadDivider(val count: Int) : ChatRow { override val key get() = "unread" }
    data class Msg(val message: ChatMessage, val showHeader: Boolean, val mine: Boolean) : ChatRow { override val key get() = "m:" + message.id }
    data class Sending(val send: PendingSend, val showHeader: Boolean) : ChatRow { override val key get() = "p:" + send.clientMsgId }
}

object MessageLayout {
    const val GROUP_WINDOW_MS = 5 * 60_000L

    fun build(messages: List<ChatMessage>, pending: List<PendingSend>, meIds: Set<String>, firstUnreadSeq: Long?, nowMs: Long,
        zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): List<ChatRow> {
        val rows = ArrayList<ChatRow>()
        var lastDay: LocalDate? = null
        var prev: ChatMessage? = null
        var dividerShown = false
        val sorted = messages.sortedBy { it.seq }
        val unreadCount = if (firstUnreadSeq == null) 0 else sorted.count { it.seq >= firstUnreadSeq && it.author.id !in meIds }
        for (m in sorted) {
            val ms = m.createdAtMillis
            val day = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
            var broke = false
            if (day != lastDay) { rows.add(ChatRow.Day(ChatFormat.dayLabel(ms, nowMs, zone, locale), "d:$day:${m.id}")); lastDay = day; broke = true }
            if (!dividerShown && firstUnreadSeq != null && unreadCount > 0 && m.seq >= firstUnreadSeq && m.author.id !in meIds) {
                rows.add(ChatRow.UnreadDivider(unreadCount)); dividerShown = true; broke = true
            }
            val p = prev
            val header = broke || p == null || p.author.id != m.author.id || p.deleted != m.deleted || ms - p.createdAtMillis > GROUP_WINDOW_MS
            rows.add(ChatRow.Msg(m, header, m.author.id in meIds))
            prev = m
        }
        var prevPendingTime = prev?.takeIf { it.author.id in meIds }?.createdAtMillis
        for (p in pending.sortedBy { it.order }) {
            val header = prevPendingTime == null || p.createdAtMs - prevPendingTime > GROUP_WINDOW_MS
            rows.add(ChatRow.Sending(p, header))
            prevPendingTime = p.createdAtMs
        }
        return rows
    }
}
