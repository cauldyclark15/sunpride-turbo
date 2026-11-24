package com.sunpride.field.ui

import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.net.toUri
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.AppEnvironment
import com.sunpride.field.BuildConfig
import kotlinx.coroutines.*

/** Independent of sign-in/bootstrap: an incompatible app must still be able to find its update. */
class FieldUpdates(private val client: FieldUpdateClient?, private val installed: Int = BuildConfig.VERSION_CODE,
    private val io: CoroutineDispatcher = Dispatchers.IO) {
    var info by mutableStateOf(client?.cached()); private set
    var busy by mutableStateOf(false); private set
    var message by mutableStateOf<String?>(null); private set
    var dismissed by mutableStateOf<Int?>(null); private set
    val required get() = info?.required(installed) == true
    val visible get() = info != null && (required || dismissed != info?.version)
    fun dismiss() { if (!required) dismissed = info?.version }
    fun cannotOpen() { message = "Could not open the update. Please try again when connected." }
    suspend fun refresh(manual: Boolean = false) {
        if (client == null || busy) return
        busy = true
        try {
            info = withContext(io) { client.check() }
            if (manual) dismissed = null
            message = if (manual && info == null) "Your app is up to date." else null
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { if (manual) message = "Could not check for updates. Try again when connected." }
        finally { busy = false }
    }
}

@Suppress("DEPRECATION")
private fun installedFromPlay(context: Context): Boolean = runCatching {
    val installer = if (Build.VERSION.SDK_INT >= 30) context.packageManager.getInstallSourceInfo(context.packageName).installingPackageName
        else context.packageManager.getInstallerPackageName(context.packageName)
    installer == PlayStoreUpdate.PLAY_PACKAGE
}.getOrDefault(false)

@Composable
fun rememberFieldUpdates(environment: AppEnvironment, offline: Boolean, resumes: Int, locked: Boolean): FieldUpdates {
    val context = LocalContext.current
    val direct = remember(context) { DistributionUpdateLink.apk && !installedFromPlay(context) }
    val updates = remember(environment.apiOrigin, direct) {
        val prefs = context.getSharedPreferences("app_updates", Context.MODE_PRIVATE)
        val pkg = context.packageName
        FieldUpdates(if (direct && environment.isReady) FieldUpdateClient(environment.apiOrigin, pkg, BuildConfig.VERSION_CODE,
            { prefs.getString(pkg, null) }, { check(prefs.edit().putString(pkg, it).commit()) }) else null)
    }
    LaunchedEffect(updates, offline, resumes, locked) {
        if (!offline && !locked) updates.refresh()
    }
    return updates
}

private fun openUpdate(context: Context, updates: FieldUpdates) {
    val urls = DistributionUpdateLink.urls(context.packageName, updates.info, installedFromPlay(context))
    for (url in urls) try {
        context.startActivity(Intent(Intent.ACTION_VIEW, url.toUri()).apply {
            if (url.startsWith("market:")) setPackage(PlayStoreUpdate.PLAY_PACKAGE)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
        return
    } catch (_: android.content.ActivityNotFoundException) { /* Try the Play web fallback. */ }
      catch (_: SecurityException) { /* Do not crash or discard work if the browser is restricted. */ }
    updates.cannotOpen()
}

@Composable
fun FieldUpdateBanner(updates: FieldUpdates, incompatible: Boolean = false) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val required = updates.required || incompatible
    if (required) AlertDialog(onDismissRequest = {}, modifier = Modifier.testTag("app-update-required"),
        title = { Text("Update needed") },
        text = { Column {
            Text("This version can no longer work. Update to continue. Your saved work stays on this phone.")
            updates.message?.let { Text(it) }
        } },
        confirmButton = { TextButton(onClick = { openUpdate(context, updates) }) { Text("Update") } },
        dismissButton = { TextButton(onClick = { scope.launch { updates.refresh(manual = true) } }, enabled = !updates.busy) { Text("Check again") } })
    else if (updates.visible) Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth().testTag("app-update-available")) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(androidx.compose.ui.res.stringResource(com.sunpride.field.R.string.app_update_available), Modifier.weight(1f).padding(vertical = 12.dp))
            TextButton(onClick = { openUpdate(context, updates) }) { Text("Update") }
            TextButton(onClick = updates::dismiss) { Text("Not now") }
        }
    }
}

@Composable
fun FieldUpdateAccount(updates: FieldUpdates) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    if (DistributionUpdateLink.apk && !installedFromPlay(context)) {
        OutlinedButton(onClick = { scope.launch { updates.refresh(manual = true) } }, enabled = !updates.busy,
            modifier = Modifier.fillMaxWidth().testTag("app-updates")) { Text(if (updates.busy) "Checking…" else "Check for updates") }
        updates.info?.let { info ->
            Text("Version ${info.name} is available. Your saved work stays on this phone.")
            OutlinedButton(onClick = { openUpdate(context, updates) }, modifier = Modifier.fillMaxWidth()) { Text("Update") }
        }
        updates.message?.let { Text(it) }
    } else {
        OutlinedButton(onClick = { openUpdate(context, updates) }, modifier = Modifier.fillMaxWidth().testTag("app-updates")) {
            Text("Check for updates on Google Play")
        }
    }
}
