package com.sunpride.catalogue

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import kotlinx.coroutines.*
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** F-004/F-015: source/effectivity/freshness are visible; no raw SAP keys or credential payloads. */
@Composable fun SapMasterCopy(fetch:(Boolean)->JSONObject?,lifetime:()->String?) {
 var open by remember {mutableStateOf(false)}
 var state by remember {mutableStateOf<JSONObject?>(null)}
 var message by remember {mutableStateOf<String?>(null)}
 var busy by remember {mutableStateOf(false)}
 var epoch by remember {mutableLongStateOf(0)}
 var request by remember {mutableStateOf<Job?>(null)}
 var displayedLifetime by remember {mutableStateOf<String?>(null)}
 val scope=rememberCoroutineScope()
 LaunchedEffect(open) {while(open) {
  delay(1_000)
  if(state!=null && (lifetime()!=displayedLifetime || System.currentTimeMillis()>=state!!.optLong("authorizationExpiresAt",0L))) {++epoch;request?.cancel();state=null;busy=false;message="Saved reference access changed or expired. Refresh today's access before reopening the copy."}
 }}
 fun load(refresh:Boolean) {
  val authorization=lifetime()
  val generation=++epoch;state=null;busy=true;message=null
  request?.cancel()
  request=scope.launch {
   try {val result=withContext(Dispatchers.IO) {fetch(refresh)};if(epoch==generation && authorization==lifetime()) {state=result;displayedLifetime=authorization}}
   catch(e:CancellationException){throw e}
   catch(_:Exception) {if(epoch==generation && authorization==lifetime()) {state=runCatching {withContext(Dispatchers.IO){fetch(false)}}.getOrNull();displayedLifetime=authorization;message=if(state==null) "Master copy is unavailable. Reconnect and refresh today's access." else "Saved copy shown. The latest SAP changes could not be checked."}}
   finally {if(epoch==generation)busy=false}
  }
 }
 OutlinedButton(onClick={open=true;load(true)},modifier=Modifier.testTag("sap-master-copy")) {Text("SAP master copy")}
 if(open) Dialog(onDismissRequest={open=false;++epoch;request?.cancel()},properties=DialogProperties(usePlatformDefaultWidth=false)) {
  Surface(Modifier.fillMaxWidth().padding(16.dp).statusBarsPadding().navigationBarsPadding(),shape=MaterialTheme.shapes.large) {
   Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
    Text("SAP master copy",style=MaterialTheme.typography.titleLarge)
    Text("Authorized reference data only. Checkout and credit still use the governed selling book, not a price calculated here.",style=MaterialTheme.typography.bodySmall)
    if(busy)Text("Checking SAP master changes…")
    message?.let {Text(it)}
    state?.let {saved->
     val rows=SapMasterMirror.current(saved)
     val format=DateTimeFormatter.ofPattern("d MMM, h:mm a").withZone(ZoneId.systemDefault())
     Text("Last received ${format.format(Instant.ofEpochMilli(saved.getLong("receivedAt")))}")
     Text("${rows.size} currently effective records"+(if(rows.size>50)" · showing the first 50" else ""))
     Column(Modifier.weight(1f,false).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
      rows.take(50).forEach {r->
       val data=r.getJSONObject("data")
       val label=when(r.getString("kind")){"material"->"Product";"customer"->"Customer";"outlet"->"Outlet";"condition"->"Price condition";"location"->"Stock location";"stock"->"Stock";else->"Receivable"}
       Text("$label · ${data.optString("name").takeIf {it.isNotBlank()}?:"SAP reference"}")
       Text("${if(r.getString("source")=="sample") "SAMPLE SAP" else "SAP"} · source version ${r.getLong("version")} · effective ${format.format(Instant.ofEpochMilli(r.getLong("effectiveFrom")))}",style=MaterialTheme.typography.bodySmall)
      }
      if(rows.isEmpty())Text("No currently authorized SAP master records in this copy. No values have been invented.")
     }
    }
    OutlinedButton(onClick={load(true)},enabled=!busy) {Text("Refresh SAP copy")}
    OutlinedButton(onClick={open=false;++epoch;request?.cancel()}) {Text("Close")}
   }
  }
 }
}
