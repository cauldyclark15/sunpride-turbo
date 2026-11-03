package com.sunpride.van.chat

import android.content.Context
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.sunpride.chat.ChatEnvironment
import com.sunpride.chat.ChatSession
import com.sunpride.chat.ChatUnreadScheduler
import com.sunpride.chat.UnreadCheck
import com.sunpride.chat.chatFailureForAuthKind
import com.sunpride.chat.ui.ChatHost
import com.sunpride.chat.ui.rememberChatUnread
import com.sunpride.van.AppEnvironment
import com.sunpride.van.BuildConfig
import com.sunpride.van.auth.AuthClient
import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.auth.KeystoreSessionVault
import com.sunpride.van.auth.RestDeviceApi
import com.sunpride.van.auth.defaultHttpClient
import com.sunpride.van.device.KeystoreDeviceKey
import com.sunpride.van.device.hex
import com.sunpride.van.device.sha256
import com.sunpride.van.ui.ListRow
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * SP-0146: the van app's side of the shared chat module. It wraps the app's own AuthClient over the same encrypted
 * session vault the van repository uses, so no second copy of any token exists.
 */
object VanChat {
    private var auth: AuthClient? = null
    private val http by lazy { defaultHttpClient() }

    /** Whether the Messages screen is showing (Home opens it; VanApp draws it). */
    var open by mutableStateOf(false)

    @Synchronized private fun auth(context: Context): AuthClient = auth ?: run {
        val app = context.applicationContext
        AuthClient(AppEnvironment(BuildConfig.API_ORIGIN), KeystoreSessionVault(app), deviceKey = {
            val key = KeystoreDeviceKey.loadOrCreate(app, KeystoreDeviceKey.DEFAULT_ALIAS)
            JSONObject().put("keyId", hex(sha256(key.publicKeySpki))).put("publicKeySpki", key.publicKeyBase64)
        }).also { auth = it }
    }

    fun session(context: Context): ChatSession {
        val client = auth(context)
        val app = context.applicationContext
        val keyId by lazy { runCatching { hex(sha256(KeystoreDeviceKey.loadOrCreate(app, KeystoreDeviceKey.DEFAULT_ALIAS).publicKeySpki)) }.getOrNull() }
        return object : ChatSession {
            override val origin = BuildConfig.API_ORIGIN.trimEnd('/')
            override val appHeader = RestDeviceApi.APP
            override fun accessToken(forceRefresh: Boolean): String =
                try { client.accessToken(forceRefresh) } catch (e: AuthFailure) { throw chatFailureForAuthKind(e.kind.name) }
            override fun invalidate() = client.invalidateAccessToken()
            override fun extraHeaders(): Map<String, String> = keyId?.let { mapOf("X-Device-Key-Id" to it) }.orEmpty()
        }
    }

    fun environment(context: Context) = ChatEnvironment(context.applicationContext, session(context), http)
}

/** The Messages screen, drawn over the van app's home while [VanChat.open] is true. */
@Composable
fun VanMessages(openConversation: String? = null) {
    val ctx = LocalContext.current
    val env = remember { VanChat.environment(ctx) }
    DisposableEffect(Unit) { onDispose { VanChat.open = false } }
    ChatHost(env, onClose = { VanChat.open = false }, modifier = Modifier.systemBarsPadding().imePadding(),
        startConversationId = openConversation)
}

/** SP-0147: a chat notification tap opens Messages at its conversation. Returns that conversation, or null. */
@Composable
fun rememberVanChatLaunch(): String? {
    val tap = com.sunpride.chat.ui.rememberChatLaunch()
    LaunchedEffect(tap) { if (tap != null) VanChat.open = true }
    return tap
}

/** The one Messages entry on Today: a row with an unread count, and the 15-minute background check. */
@Composable
fun VanMessagesEntry() {
    val ctx = LocalContext.current
    val env = remember { VanChat.environment(ctx) }
    val unread = rememberChatUnread(env)
    LaunchedEffect(Unit) { runCatching { ChatUnreadScheduler.schedule(ctx, VanChatUnreadWorker::class.java) } }
    ListRow("Messages", if (unread > 0) "$unread unread · chat with the office and your team" else "Chat with the office, your team and AI users", "open-messages",
        onClick = { VanChat.open = true })
}

class VanChatUnreadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ok = withContext(Dispatchers.IO) {
            runCatching { UnreadCheck.run(applicationContext, VanChat.session(applicationContext), VanChat.environment(applicationContext).http) }.getOrDefault(true)
        }
        return if (ok) Result.success() else Result.retry()
    }
}
