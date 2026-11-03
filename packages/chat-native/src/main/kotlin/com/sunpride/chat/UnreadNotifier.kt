package com.sunpride.chat

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit

/**
 * A notification tap carries the conversation to open ([EXTRA_CONVERSATION]). The host app's activity hands its
 * intents to [offer] (see `rememberChatLaunch`), and the app opens Messages at [pending].
 */
object ChatLaunch {
    const val EXTRA_CONVERSATION = "com.sunpride.chat.CONVERSATION_ID"
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
    private val _pending = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    val pending: kotlinx.coroutines.flow.StateFlow<String?> = _pending

    /** Accepts a conversation id from a tap; anything that is not a conversation id is ignored. */
    fun accept(conversationId: String?): Boolean {
        val id = conversationId?.takeIf { UUID.matches(it) } ?: return false
        _pending.value = id
        return true
    }
    /** Reads, then removes, the extra so a rotation or relaunch does not reopen the same conversation. */
    fun offer(intent: android.content.Intent?) {
        val id = intent?.getStringExtra(EXTRA_CONVERSATION) ?: return
        intent.removeExtra(EXTRA_CONVERSATION)
        accept(id)
    }
    /** The conversation was opened. */
    fun clear(conversationId: String) { _pending.compareAndSet(conversationId, null) }

    /** The app's launch intent, reusing the running screen, with the conversation to open. */
    fun tapIntent(context: Context, conversationId: String): android.content.Intent? =
        context.packageManager.getLaunchIntentForPackage(context.packageName)?.apply {
            putExtra(EXTRA_CONVERSATION, conversationId)
            addFlags(android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
}

data class NotifyItem(val conversationId: String, val title: String, val text: String, val mention: Boolean)

/** Decides which unread changes deserve a notification: new mentions, and new messages in a direct chat. */
object UnreadDiff {
    /** conversation id → (unread, mentions) as of the last check. */
    fun decide(previous: Map<String, Pair<Int, Int>>?, now: List<UnreadConversation>, lookup: (String) -> Conversation?, meIds: Set<String>): List<NotifyItem> {
        if (previous == null) return emptyList()            // first ever check: set the baseline, don't announce old messages
        val out = ArrayList<NotifyItem>()
        for (u in now) {
            val before = previous[u.id] ?: (0 to 0)
            val c = lookup(u.id)
            val newMention = u.mentionCount > before.second
            val newDirect = c != null && c.isDm && !c.muted && u.unreadCount > before.first
            if (!newMention && !newDirect) continue
            val last = c?.lastMessage
            val who = last?.author?.displayName ?: "Someone"
            val title = if (newMention && c != null && !c.isDm) "$who mentioned you in ${ChatFormat.title(c, meIds)}" else ChatFormat.title(c ?: continue, meIds)
            val text = c?.let { ChatFormat.lastLine(it, meIds) }.orEmpty().ifBlank { "New message" }
            out.add(NotifyItem(u.id, title, text, newMention))
        }
        return out
    }
}

/** Runs from WorkManager every 15 minutes: one small /unread call, a local notification if something new needs you. */
object UnreadCheck {
    private const val PREFS = "sunpride_chat_unread"
    const val CHANNEL = "chat_messages"

    /** Returns false when it should be retried (offline); signed-out or expired sessions simply stop quietly. */
    fun run(context: Context, session: ChatSession, http: OkHttpClient): Boolean {
        val api = ChatApi(session, http)
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val summary = try { api.unread() }
        catch (e: ChatException) { return e !is ChatException.Offline && e !is ChatException.Server }
        val previous = if (!prefs.contains("state")) null else runCatching {
            val o = org.json.JSONObject(prefs.getString("state", "{}")!!)
            o.keys().asSequence().associateWith { k -> o.getJSONArray(k).let { it.getInt(0) to it.getInt(1) } }
        }.getOrDefault(emptyMap())
        val interesting = summary.conversations.any { u -> val b = previous?.get(u.id) ?: (0 to 0); u.mentionCount > b.second || u.unreadCount > b.first }
        var items = emptyList<NotifyItem>()
        if (interesting && previous != null) {
            val convs = runCatching { api.conversations().items }.getOrDefault(emptyList()).associateBy { it.id }
            val me = prefs.getStringSet("me", emptySet()).orEmpty()
            items = UnreadDiff.decide(previous, summary.conversations, { convs[it] }, me)
        }
        val saved = org.json.JSONObject()
        summary.conversations.forEach { saved.put(it.id, org.json.JSONArray().put(it.unreadCount).put(it.mentionCount)) }
        prefs.edit().putString("state", saved.toString()).apply()
        items.forEach { notify(context, it) }
        return true
    }

    fun rememberMe(context: Context, ids: Set<String>) { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putStringSet("me", ids).apply() }
    /** Another account (or nobody) is signed in: forget who "me" was and the last counts seen. */
    fun forget(context: Context) { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply() }

    private fun canNotify(context: Context): Boolean =
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) &&
            NotificationManagerCompat.from(context).areNotificationsEnabled()

    @android.annotation.SuppressLint("MissingPermission") // canNotify() checks POST_NOTIFICATIONS first
    private fun notify(context: Context, item: NotifyItem) {
        if (!canNotify(context)) return
        val nm = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) nm.createNotificationChannel(NotificationChannel(CHANNEL, "Messages", NotificationManager.IMPORTANCE_DEFAULT)
            .apply { description = "Mentions and direct messages" })
        // One PendingIntent per conversation, so each notification opens its own conversation.
        val launch = ChatLaunch.tapIntent(context, item.conversationId)
        val tap = launch?.let { PendingIntent.getActivity(context, item.conversationId.hashCode(), it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
        val n = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(item.title).setContentText(item.text).setStyle(NotificationCompat.BigTextStyle().bigText(item.text))
            .setAutoCancel(true).setContentIntent(tap).setCategory(NotificationCompat.CATEGORY_MESSAGE).build()
        runCatching { NotificationManagerCompat.from(context).notify(item.conversationId.hashCode(), n) }
    }
}

object ChatUnreadScheduler {
    const val NAME = "sunpride-chat-unread"
    /** Idempotent: safe to call every time Messages is shown. 15 minutes is WorkManager's minimum period. */
    fun schedule(context: Context, worker: Class<out ListenableWorker>) {
        val request = PeriodicWorkRequest.Builder(worker, 15, TimeUnit.MINUTES)
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
        WorkManager.getInstance(context.applicationContext).enqueueUniquePeriodicWork(NAME, ExistingPeriodicWorkPolicy.KEEP, request)
    }
}
