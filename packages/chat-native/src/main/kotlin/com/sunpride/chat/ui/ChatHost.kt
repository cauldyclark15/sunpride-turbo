package com.sunpride.chat.ui

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.chat.Attachment
import com.sunpride.chat.ChatApi
import com.sunpride.chat.ChatEnvironment
import com.sunpride.chat.ChatRuntime
import com.sunpride.chat.ChatServices
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

/** True while the app is on screen and in front; polling pauses otherwise. */
@Composable
fun rememberChatForeground(): Boolean {
    val owner = LocalLifecycleOwner.current
    var resumed by remember { mutableStateOf(owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    DisposableEffect(owner) {
        val observer = LifecycleEventObserver { _, _ -> resumed = owner.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED) }
        owner.lifecycle.addObserver(observer)
        onDispose { owner.lifecycle.removeObserver(observer) }
    }
    return resumed
}

/** The unread number for the Messages entry. Asks the office once a minute while the app is in front. */
@Composable
fun rememberChatUnread(env: ChatEnvironment): Int {
    val foreground = rememberChatForeground()
    val total = produceState(0, env, foreground) {
        if (!foreground) return@produceState
        while (true) {
            withContext(Dispatchers.IO) { runCatching { ChatApi(env.session, env.http).unread().total }.getOrNull() }?.let { value = it }
            delay(60_000)
        }
    }
    return total.value
}

/**
 * The whole Messages experience. [onClose] runs when Back is pressed on the conversation list, so the host app
 * returns to where it was. Inside, Back steps back one screen; every sheet and viewer closes with Back too.
 */
@Composable
fun ChatHost(env: ChatEnvironment, onClose: () -> Unit, modifier: Modifier = Modifier, startConversationId: String? = null) {
    val ctx = LocalContext.current
    var runtime by remember { mutableStateOf<ChatRuntime?>(null) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    LaunchedEffect(env, attempt) {
        failed = false
        runtime = withContext(Dispatchers.IO) { runCatching { ChatServices.runtime(env) }.getOrNull() }
        failed = runtime == null
    }
    // Screens are kept as a small text stack ("list|conv:ID|thread:ID:PARENT") so rotation keeps your place.
    var stackText by rememberSaveable { mutableStateOf(if (startConversationId != null) "list|conv:$startConversationId" else "list") }
    val stack = stackText.split("|")
    val top = stack.last()
    fun push(r: String) { stackText = "$stackText|$r" }
    fun pop() { stackText = if (stack.size > 1) stack.dropLast(1).joinToString("|") else "list" }
    var viewer by remember { mutableStateOf<Attachment?>(null) }
    var detailsFor by remember { mutableStateOf<String?>(null) }

    BackHandler(enabled = true) { if (stack.size > 1) pop() else onClose() }

    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    LaunchedEffect(Unit) {
        val prefs = ctx.getSharedPreferences("sunpride_chat_ui", android.content.Context.MODE_PRIVATE)
        if (Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("asked_notifications", false) &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            prefs.edit().putBoolean("asked_notifications", true).apply()
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // Realtime: this app has no websocket, so the open screen is refreshed every 5 seconds while it is in front.
    val foreground = rememberChatForeground()
    LaunchedEffect(runtime, foreground, top) {
        val rt = runtime ?: return@LaunchedEffect
        if (!foreground) return@LaunchedEffect
        val parts = top.split(":")
        val conv = if (parts[0] == "conv" || parts[0] == "thread") parts.getOrNull(1) else null
        val parent = if (parts[0] == "thread") parts.getOrNull(2) else null
        while (true) {
            rt.repository.tick(conv, parent)
            delay(5_000)
        }
    }

    Column(modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).imePadding()) {
        val rt = runtime
        when {
            rt == null && !failed -> {
                ChatTopBar("Messages", onClose)
                Box(Modifier.fillMaxSize(), Alignment.Center) { Text("Opening Messages…") }
            }
            rt == null -> {
                ChatTopBar("Messages", onClose)
                Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = androidx.compose.foundation.layout.Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Messages couldn't open. Connect to the internet once, then try again.", style = MaterialTheme.typography.bodyLarge)
                    TextButton(onClick = { attempt++ }) { Text("Try again") }
                }
            }
            else -> CompositionLocalProvider(LocalChat provides rt, LocalChatEnv provides env) {
                val parts = top.split(":")
                when (parts[0]) {
                    "conv" -> ConversationScreen(parts[1], null, onBack = ::pop, onOpenThread = { push("thread:${parts[1]}:$it") },
                        onDetails = { detailsFor = parts[1] }, onViewImage = { viewer = it })
                    "thread" -> ConversationScreen(parts[1], parts[2], onBack = ::pop, onOpenThread = {}, onDetails = {}, onViewImage = { viewer = it })
                    "new" -> NewChatScreen(onBack = ::pop, onCreated = { id -> stackText = (stack.dropLast(1) + "conv:$id").joinToString("|") })
                    "search" -> SearchScreen(onBack = ::pop, onOpen = { id -> push("conv:$id") })
                    else -> ConversationListScreen(onClose = onClose, onOpen = { push("conv:$it") }, onNew = { push("new") }, onSearch = { push("search") })
                }
                viewer?.let { ImageViewerDialog(it) { viewer = null } }
                detailsFor?.let { id -> DetailsSheet(id, onDismiss = { detailsFor = null }, onLeft = { detailsFor = null; stackText = "list" }) }
            }
        }
    }
}
