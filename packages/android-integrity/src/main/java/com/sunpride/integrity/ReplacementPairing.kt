package com.sunpride.integrity

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import org.json.JSONObject

/** F-007: no private key leaves the Keystore; the office receives only an expiring human code. */
fun replacementPairingBody(app: String,key: JSONObject,sign: (String)->String,at: Long=System.currentTimeMillis()):JSONObject =
    JSONObject().put("publicKeySpki",key.getString("publicKeySpki")).put("timestamp",at)
        .put("signature",sign("PAIR|$app|${key.getString("keyId")}|$at"))

@Composable fun ReplacementPairing(fetch: ()->JSONObject) {
    val scope=rememberCoroutineScope()
    var code by remember {mutableStateOf<String?>(null)}
    var expires by remember {mutableStateOf(0L)}
    var now by remember {mutableStateOf(System.currentTimeMillis())}
    var busy by remember {mutableStateOf(false)}
    var failed by remember {mutableStateOf(false)}
    LaunchedEffect(code) {while(code!=null && now<expires) {delay(1_000);now=System.currentTimeMillis()}}
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text("Replacing another phone? Sign in as the same person, then give this short code to the office. No phone activates until the old work is reconciled.")
        code?.let {Text(if(now<expires) it else "Code expired. Get a new replacement code.",modifier=Modifier.testTag("replacement-code"))}
        if(failed) Text("Could not get a code. Reconnect and sign in again if your session expired.")
        OutlinedButton(enabled=!busy,onClick={scope.launch {
            busy=true;failed=false
            try {val r=withContext(Dispatchers.IO) {fetch()};code=r.getString("code");expires=r.getLong("expiresAt");now=System.currentTimeMillis()}
            catch(e: kotlinx.coroutines.CancellationException) {throw e}
            catch(_:Exception) {failed=true;code=null}
            finally {busy=false}
        }},modifier=Modifier.testTag("get-replacement-code")) {Text(if(busy) "Getting code…" else "Get replacement code")}
    }
}
