package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.evidence.DamageCameraScreen
import kotlinx.coroutines.launch
import org.json.JSONObject

/** F-107: camera, compression, private capture files and durable upload are the existing van photo adapters. */
@Composable fun VanCallEvidenceButton(c: VanController) {
    var camera by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    val scope=rememberCoroutineScope()
    SecondaryButton("Take call photo",{camera=true},Modifier.testTag("callflow-evidence"),!c.busy && !saving)
    message?.let { Text(it) }
    if(camera) Dialog(onDismissRequest={if(!saving)camera=false},properties=DialogProperties(usePlatformDefaultWidth=false,decorFitsSystemWindows=false)) {
        Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
            DamageCameraScreen({capture->
                camera=false;saving=true
                scope.launch {
                    try {
                        val outlet=c.selectedCustomer?.outletId ?: return@launch
                        val photo=c.repository.saveDamagePhoto(capture)
                        c.repository.recordCall("call.step",outlet,null,JSONObject().put("adapter","evidence").put("photoSha256",photo.sha256))
                        message="Call photo saved on this phone. It uploads with this call."
                    } catch(e: kotlinx.coroutines.CancellationException) { throw e }
                    catch(_:Exception) { message="Could not save the photo. Retake and try again." }
                    finally { saving=false }
                }
            },{camera=false})
        }
    }
}
