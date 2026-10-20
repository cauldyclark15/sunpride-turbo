package com.sunpride.integrity

import android.content.Intent
import androidx.core.net.toUri
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import kotlinx.coroutines.*
import org.json.JSONObject

/** F-007: shared browser handoff in the existing field and van apps; no WebView passwords. */
@Composable fun CompanySignIn(origin: String, app: String, enabled: Boolean,
    key: () -> JSONObject, sign: (String) -> String,
    onWaiting: (Boolean) -> Unit, onCredentials: (JSONObject) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val client = remember(origin,app) { CompanySignInClient(origin,app,key,sign) }
    var providers by remember { mutableStateOf<List<CompanyProvider>>(emptyList()) }
    var waiting by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var job by remember { mutableStateOf<Job?>(null) }
    val currentWaiting by rememberUpdatedState(onWaiting)
    val currentCredentials by rememberUpdatedState(onCredentials)
    DisposableEffect(Unit) { onDispose { currentWaiting(false) } }
    fun start(provider: CompanyProvider) {
        job = scope.launch {
            waiting=true; currentWaiting(true); message=null
            try {
                val request=withContext(Dispatchers.IO) { client.start(provider.code) }
                context.startActivity(Intent(Intent.ACTION_VIEW,request.url.toUri()))
                message="Finish company sign-in in your browser, then return here."
                repeat(95) {
                    delay(3_000)
                    val credentials=withContext(Dispatchers.IO) { client.poll(request) }
                    ensureActive()
                    if(credentials != null) { currentCredentials(credentials); return@launch }
                }
                message="Company sign-in expired. Start again."
            } catch(e: CancellationException) { throw e }
            catch(_: Exception) { message="Company sign-in could not finish. Check your connection and try again." }
            finally { waiting=false; currentWaiting(false) }
        }
    }
    Column {
        OutlinedButton(onClick={
            job=scope.launch {
                waiting=true; currentWaiting(true); message=null
                try {
                    providers=withContext(Dispatchers.IO) { client.providers() }
                    if(providers.isEmpty()) message="Company sign-in is not configured. Use your password or ask the office to configure it."
                } catch(_: Exception) { message="Company sign-in needs an internet connection. Password sign-in stays available." }
                finally { waiting=false; currentWaiting(false) }
            }
        }, enabled=enabled && !waiting, modifier=Modifier.fillMaxWidth().testTag("company-sign-in")) { Text("Company sign-in") }
        if(!waiting) providers.forEach { provider ->
            OutlinedButton(onClick={start(provider)},enabled=enabled,modifier=Modifier.fillMaxWidth()) { Text(provider.label) }
        }
        if(waiting) OutlinedButton(onClick={job?.cancel();providers=emptyList();message="Company sign-in cancelled."},modifier=Modifier.fillMaxWidth()) { Text("Cancel company sign-in") }
        message?.let { Text(it,modifier=Modifier.testTag("company-sign-in-status")) }
    }
}
