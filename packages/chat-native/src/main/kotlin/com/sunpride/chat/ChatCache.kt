package com.sunpride.chat

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** The last [KEEP] messages of each conversation (or thread), plus the conversation list, for offline reading. */
interface ChatCache {
    fun messages(key: String): List<ChatMessage>
    fun putMessages(key: String, items: List<ChatMessage>)
    fun conversations(): List<Conversation>
    fun putConversations(items: List<Conversation>)
    companion object { const val KEEP = 50 }
}

internal fun newestFirstTrim(items: List<ChatMessage>): List<ChatMessage> =
    items.distinctBy { it.id }.sortedBy { it.seq }.takeLast(ChatCache.KEEP)

class MemoryChatCache : ChatCache {
    private val m = HashMap<String, List<ChatMessage>>()
    private var c: List<Conversation> = emptyList()
    @Synchronized override fun messages(key: String) = m[key].orEmpty()
    @Synchronized override fun putMessages(key: String, items: List<ChatMessage>) { m[key] = newestFirstTrim(items) }
    @Synchronized override fun conversations() = c
    @Synchronized override fun putConversations(items: List<Conversation>) { c = items }
}

/** In-memory first, written through to JSON files so a restart (or no network) still shows history. */
class FileChatCache(private val dir: File) : ChatCache {
    private val memory = MemoryChatCache()
    private val loaded = HashSet<String>()

    private fun file(name: String) = File(dir, name.replace(Regex("[^A-Za-z0-9_-]"), "_") + ".json")
    private fun write(f: File, json: String) {
        dir.mkdirs()
        val tmp = File(dir, f.name + ".tmp")
        tmp.writeText(json)
        if (!tmp.renameTo(f)) { f.delete(); tmp.renameTo(f) }
    }

    @Synchronized override fun messages(key: String): List<ChatMessage> {
        if (loaded.add("m:$key")) {
            val f = file("m-$key")
            if (f.exists() && memory.messages(key).isEmpty()) {
                val parsed = runCatching { JSONArray(f.readText()).mapObjects(ChatMessage::from) }.getOrDefault(emptyList())
                if (parsed.isNotEmpty()) memory.putMessages(key, parsed)
            }
        }
        return memory.messages(key)
    }
    @Synchronized override fun putMessages(key: String, items: List<ChatMessage>) {
        loaded.add("m:$key")
        memory.putMessages(key, items)
        runCatching { write(file("m-$key"), JSONArray(memory.messages(key).map { it.toJson() }).toString()) }
    }
    @Synchronized override fun conversations(): List<Conversation> {
        if (loaded.add("c")) {
            val f = file("conversations")
            if (f.exists() && memory.conversations().isEmpty()) {
                runCatching { JSONArray(f.readText()).mapObjects(Conversation::from) }.getOrNull()?.let { memory.putConversations(it) }
            }
        }
        return memory.conversations()
    }
    @Synchronized override fun putConversations(items: List<Conversation>) {
        loaded.add("c")
        memory.putConversations(items)
        runCatching { write(file("conversations"), JSONArray(items.map { it.toJson() }).toString()) }
    }
}
