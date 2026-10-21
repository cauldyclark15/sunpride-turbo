package com.sunpride.integrity

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.*
import org.json.JSONObject
import java.io.File

/** F-006: explicit update discovery/download/Android-confirmation, outside the business outbox. */
@Composable fun AppUpdatePanel(client:()->AppUpdateClient?,lifetime:()->String?) {
 val scope=rememberCoroutineScope()
 var open by remember {mutableStateOf(false)}
 var busy by remember {mutableStateOf(false)}
 var release by remember {mutableStateOf<JSONObject?>(null)}
 var file by remember {mutableStateOf<File?>(null)}
 var message by remember {mutableStateOf("")}
 var epoch by remember {mutableLongStateOf(0)}
 var task by remember {mutableStateOf<Job?>(null)}
 fun action(kind:String) {
  val generation=++epoch;val account=lifetime()
  val current={epoch==generation && lifetime()==account && account!=null}
  busy=true;message="";task?.cancel()
  task=scope.launch {
   try {
    val api=checkNotNull(client())
    when(kind) {
     "check"->{file=null;release=null;val r=withContext(Dispatchers.IO){api.latest()};if(current()){release=r;message=if(r==null)"This app is up to date in the office's update channel." else "Signed update available. Your saved work stays on this phone."}}
     "download"->{val r=checkNotNull(release);val f=withContext(Dispatchers.IO){api.download(r,current)};if(current()){file=f;message="Download verified against the installed app's signing certificate. Android will ask you to confirm installation."}}
     "install"->{val f=checkNotNull(file);val r=checkNotNull(release);withContext(Dispatchers.IO){api.install(f,r,current)};if(current())message="If Android asked for permission, allow updates from Sunpride, return here, and tap Install again. Android confirms the update; queued work is not reset."}
    }
   }catch(e:CancellationException){throw e}
   catch(_:Exception){if(current())message="Update not available or verification failed. Reconnect and check again; no app was installed."}
   finally {if(epoch==generation)busy=false}
  }
 }
 OutlinedButton(onClick={open=true;action("check")},modifier=Modifier.testTag("app-updates")) {Text("Check app updates")}
 if(open)Dialog(onDismissRequest={open=false;++epoch;task?.cancel()},properties=DialogProperties(usePlatformDefaultWidth=false)) {
  Surface(Modifier.fillMaxWidth().padding(16.dp).statusBarsPadding().navigationBarsPadding(),shape=MaterialTheme.shapes.large) {
   Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
    Text("App updates",style=MaterialTheme.typography.titleLarge)
    if(busy)Text("Checking or verifying update…")
    if(message.isNotBlank())Text(message)
    Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
     release?.let {r->Text("Version ${r.getString("versionName")}");Text(r.getString("notes"));Text("Only the same app and installed signer are accepted. No downgrade, silent install, or clearing of saved work.",style=MaterialTheme.typography.bodySmall)}
    }
    if(release!=null)OutlinedButton(onClick={action(if(file==null)"download" else "install")},enabled=!busy) {Text(if(file==null)"Download signed update" else "Install verified update")}
    OutlinedButton(onClick={action("check")},enabled=!busy) {Text("Check again")}
    OutlinedButton(onClick={open=false;++epoch;task?.cancel()}) {Text("Close")}
   }
  }
 }
}
