package com.sunpride.field.chat

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.sunpride.chat.AccountTokenGuard
import com.sunpride.chat.ChatAccount
import com.sunpride.chat.ChatEnvironment
import com.sunpride.chat.ChatServices
import com.sunpride.chat.ChatSession
import com.sunpride.chat.ChatUnreadScheduler
import com.sunpride.chat.UnreadCheck
import com.sunpride.chat.chatFailureForAuthKind
import com.sunpride.chat.ui.ChatHost
import com.sunpride.chat.ui.rememberChatUnread
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import com.sunpride.field.auth.AuthClient
import com.sunpride.field.auth.AuthFailure
import com.sunpride.field.auth.NativeApi
import com.sunpride.field.auth.SessionVault
import com.sunpride.field.auth.SessionVaults
import com.sunpride.field.auth.defaultHttpClient
import com.sunpride.field.device.KeystoreDeviceKey
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.SecondaryButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * SP-0146: the field app's side of the shared chat module. The module only needs the v2 origin and a bearer, so this
 * wraps the app's own AuthClient and session vault (no tokens are stored here).
 */
object FieldChat {
    private var auth: AuthClient? = null
    private var vault: SessionVault? = null
    private var guard: AccountTokenGuard? = null

    @Synchronized private fun auth(context: Context): AuthClient = auth ?: run {
        val app = context.applicationContext
        val v = SessionVaults.app(app)
        vault = v
        AuthClient(AppEnvironment(BuildConfig.SUNPRIDE_API_ORIGIN), v, signer = { KeystoreDeviceKey.loadOrCreate(app) }).also { client ->
            auth = client
            guard = AccountTokenGuard({ account() }, client::invalidateAccessToken)
        }
    }

    /** SP-0148: the signed-in session, as a one-way id; chat state belongs to exactly this account. */
    private fun account(): String? = ChatAccount.of(runCatching { vault?.readSession() }.getOrNull())

    fun session(context: Context): ChatSession {
        val client = auth(context)
        val tokens = checkNotNull(guard)
        return object : ChatSession {
            override val origin = BuildConfig.SUNPRIDE_API_ORIGIN.trimEnd('/')
            override val appHeader = NativeApi.APP
            // A token cached for the previous person is dropped as soon as another session is stored.
            override fun accessToken(forceRefresh: Boolean): String = tokens.token {
                try { client.accessToken(forceRefresh) } catch (e: AuthFailure) { throw chatFailureForAuthKind(e.kind.name) }
            }
            override fun invalidate() = client.invalidateAccessToken()
            override fun extraHeaders(): Map<String, String> = client.deviceKeyId()?.let { mapOf("X-Device-Key-Id" to it) }.orEmpty()
            override fun account(): String? = FieldChat.account()
        }
    }

    /** SP-0148: the app signed out. Polling and sending stop and this phone's saved chat is deleted. */
    fun signOut(context: Context) {
        synchronized(this) { guard?.reset() }
        ChatServices.signOut(context.applicationContext)
    }

    /** SP-0147: Messages draws its own top bar, so the app's bar is hidden there (one bar on screen, never two). */
    fun appBarVisible(ready: Boolean, page: String): Boolean = !(ready && page == "messages")

    fun environment(context: Context, openHref: (String) -> Boolean = { false }) =
        ChatEnvironment(context.applicationContext, session(context), defaultHttpClient(), openHref)
}

/**
 * Messages page. [openHref] opens an object in the app when it has a screen for it (a store, today);
 * [openConversation] is the conversation a notification tap asked for, if any.
 */
@Composable
fun FieldMessages(modifier: Modifier, openConversation: String?, onClose: () -> Unit, openHref: (String) -> Boolean) {
    val ctx = LocalContext.current
    val latest by rememberUpdatedState(openHref)
    val env = remember { FieldChat.environment(ctx) { latest(it) } }
    ChatHost(env, onClose, modifier, startConversationId = openConversation)
}

/** The one Messages entry on Today: a card with an unread count, and the 15-minute background check. */
@Composable
fun FieldMessagesEntry(onOpen: () -> Unit) {
    val ctx = LocalContext.current
    val env = remember { FieldChat.environment(ctx) }
    val unread = rememberChatUnread(env)
    LaunchedEffect(Unit) { runCatching { ChatUnreadScheduler.schedule(ctx, FieldChatUnreadWorker::class.java) } }
    SectionCard("Messages") {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Chat with your team, the office and AI users.", style = MaterialTheme.typography.bodyMedium)
            SecondaryButton(if (unread > 0) "Open Messages · $unread unread" else "Open Messages", onOpen, Modifier.testTag("messages-open"))
        }
    }
}

/** Every 15 minutes: one small unread check; a local notification for a new mention or direct message. */
class FieldChatUnreadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val ok = withContext(Dispatchers.IO) {
            runCatching { UnreadCheck.run(applicationContext, FieldChat.session(applicationContext), defaultHttpClient()) }.getOrDefault(true)
        }
        return if (ok) Result.success() else Result.retry()
    }
}
