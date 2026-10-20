package com.sunpride.van.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.callflow.CallFlowEngine
import com.sunpride.van.evidence.DamageCameraScreen
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

/** F-303 F-304: a configured step inside the existing call panel, never a separate driver app/engine. */
@Composable fun DriverDeliveryPanel(c: VanController) {
    val customer=c.selectedCustomer ?: return
    val context=LocalContext.current
    val scope=rememberCoroutineScope()
    var drops by remember(customer.outletId) { mutableStateOf<List<JSONObject>>(emptyList()) }
    var problem by remember(customer.outletId) { mutableStateOf<String?>(null) }
    LaunchedEffect(customer.outletId) { runCatching { c.repository.deliveryDrops() }.onSuccess { drops=it.filter { it.getString("outletId")==customer.outletId } }.onFailure { problem="Sync the driver manifest first." } }
    problem?.let { Text(it,color=MaterialTheme.colorScheme.error) }
    drops.forEach { drop -> key(drop.getString("dropId")) {
        val expected=CallFlowEngine.objects(drop.getJSONArray("lines"))
        var receiver by remember { mutableStateOf("") }
        var reason by remember { mutableStateOf("") }
        var notes by remember { mutableStateOf("") }
        var accepted by remember { mutableStateOf(expected.map { it.getLong("expectedBase").toString() }) }
        var shorts by remember { mutableStateOf(expected.map { "0" }) }
        var rejected by remember { mutableStateOf(expected.map { "0" }) }
        var damaged by remember { mutableStateOf(expected.map { "0" }) }
        var batches by remember { mutableStateOf(expected.map { "" }) }
        var signature by remember { mutableStateOf<List<Offset>>(emptyList()) }
        var camera by remember { mutableStateOf(false) }
        var saving by remember { mutableStateOf(false) }
        var message by remember { mutableStateOf<String?>(null) }
        val saved=drop.getString("status")!="scheduled"
        Text("Drop ${drop.getInt("sequence")} · ${drop.getString("orderNumber")} · ${drop.getString("confirmedDeliveryDate")}",style=MaterialTheme.typography.titleSmall)
        drop.optString("bookingReference").takeIf { it.isNotBlank() && it!="null" }?.let { Text("Appointment · $it") }
        if(saved) Text(if(drop.getString("status")=="saved_on_phone") "Proof saved on this phone. Sync sends the signature and photo." else "Delivery already confirmed.",Modifier.testTag("delivery-saved"))
        else {
            Text("Count base pieces. Accepted + short + rejected + damaged must equal expected.")
            expected.forEachIndexed { i,line ->
                Text("${line.getString("description")} · Expected ${line.getLong("expectedBase")} pieces")
                LabeledField("Accepted pieces",accepted[i],{v->accepted=accepted.toMutableList().also{it[i]=v}},"delivery-accepted-$i")
                LabeledField("Short pieces",shorts[i],{v->shorts=shorts.toMutableList().also{it[i]=v}},"delivery-short-$i")
                LabeledField("Rejected pieces",rejected[i],{v->rejected=rejected.toMutableList().also{it[i]=v}},"delivery-rejected-$i")
                LabeledField("Damaged pieces",damaged[i],{v->damaged=damaged.toMutableList().also{it[i]=v}},"delivery-damaged-$i")
                LabeledField("Delivered batch (when applicable)",batches[i],{v->batches=batches.toMutableList().also{it[i]=v}},"delivery-batch-$i")
            }
            Text("Reason for any door variance")
            CallFlowEngine.objects(drop.getJSONArray("reasons")).forEach { r-> Row { RadioButton(reason==r.getString("code"),{reason=r.getString("code")},Modifier.testTag("delivery-reason-${r.getString("code")}"));Text(r.getString("label"),Modifier.padding(top=12.dp)) } }
            LabeledField("Door note",notes,{notes=it},"delivery-note")
            LabeledField("Receiving person's name",receiver,{receiver=it},"delivery-receiver")
            Text("Receiver signature — draw in the box")
            Canvas(Modifier.fillMaxWidth().height(150.dp).testTag("delivery-signature").pointerInput(drop.getString("dropId")) {
                detectDragGestures(onDragStart={p->signature=listOf(Offset((p.x/size.width).coerceIn(0f,1f),(p.y/size.height).coerceIn(0f,1f)))}) { change,_->
                    change.consume();if(signature.size<2048) signature=signature+Offset((change.position.x/size.width).coerceIn(0f,1f),(change.position.y/size.height).coerceIn(0f,1f))
                }
            }) {
                drawRect(Color.LightGray,style=androidx.compose.ui.graphics.drawscope.Stroke(2f))
                signature.zipWithNext().forEach { (a,b)->drawLine(Color.Gray,Offset(a.x*size.width,a.y*size.height),Offset(b.x*size.width,b.y*size.height),3f) }
            }
            SecondaryButton("Clear signature",{signature=emptyList()},enabled=!saving)
            SecondaryButton("Take photo and save delivery",{camera=true},Modifier.testTag("delivery-photo-save"),!saving && !c.busy && receiver.isNotBlank() && signature.size>=2)
        }
        if(saved) LabeledField("Timing note or outside-window reason",notes,{notes=it},"delivery-note")
        Row(horizontalArrangement=Arrangement.spacedBy(4.dp)) { listOf("arrival","unloading","departure").forEach { stage->
            val ready=when(stage) {
                "arrival"->drop.isNull("arrivedAt") || !drop.has("arrivedAt")
                "unloading"->drop.has("arrivedAt")&&!drop.isNull("arrivedAt") && (drop.isNull("unloadingAt") || !drop.has("unloadingAt"))
                else->saved && drop.has("unloadingAt")&&!drop.isNull("unloadingAt") && (drop.isNull("departedAt") || !drop.has("departedAt"))
            }
            SecondaryButton(stage.replaceFirstChar(Char::uppercase),{
                saving=true
                scope.launch { try {
                    c.repository.recordCall("delivery.timing",customer.outletId,null,JSONObject().put("dropId",drop.getString("dropId")).put("stage",stage).put("reason",notes))
                    drops=c.repository.deliveryDrops().filter {it.getString("outletId")==customer.outletId};message="Delivery time saved on this phone."
                } catch(e:kotlinx.coroutines.CancellationException){throw e} catch(e:Exception){message=e.message?.takeIf{it.length<160} ?: "Could not record this delivery time."} finally {saving=false} }
            },Modifier.weight(1f).testTag("delivery-timing-$stage"),!saving&&!c.busy&&ready)
        } }
        message?.let { Text(it,Modifier.testTag("delivery-message")) }
        if(camera) Dialog(onDismissRequest={if(!saving)camera=false},properties=DialogProperties(usePlatformDefaultWidth=false,decorFitsSystemWindows=false)) {
            Surface(Modifier.fillMaxSize().safeDrawingPadding()) {
                DamageCameraScreen({capture->camera=false;saving=true;scope.launch {
                    try {
                        val fix=checkNotNull(c.callLocationSource?.invoke() ?: com.sunpride.callflow.AndroidCallLocation.capture(context)) { "A fresh precise location is required." }
                        val lines=JSONArray().apply { expected.forEachIndexed { i,l->
                            put(JSONObject().put("lineId",l.getString("lineId")).put("acceptedBase",accepted[i].toLong()).put("shortBase",shorts[i].toLong()).put("rejectedBase",rejected[i].toLong()).put("damagedBase",damaged[i].toLong()).apply {
                                if(reason.isNotBlank())put("reason",reason);if(notes.isNotBlank())put("note",notes);if(batches[i].isNotBlank())put("lotNumber",batches[i])
                            })
                        } }
                        c.repository.recordDelivery(customer.outletId,capture,fix,receiver,JSONArray().apply { signature.forEach { p->put(JSONArray().put(p.x.toDouble()).put(p.y.toDouble())) } },lines,drop.getString("dropId"))
                        drops=c.repository.deliveryDrops().filter { it.getString("outletId")==customer.outletId }
                        message="Signature and watermarked photo saved offline. Sync sends this exact proof."
                    } catch(e:kotlinx.coroutines.CancellationException){throw e} catch(e:Exception){message=e.message?.takeIf{it.length<160} ?: "Could not save the delivery. Check quantities, signature and location."}
                    finally {saving=false}
                }},{camera=false})
            }
        }
    } }
    if(drops.isEmpty()) Text("No released delivery drops for this store. Ask dispatch to assign and release a manifest, then sync.")
}
