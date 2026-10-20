package com.sunpride.field.ui.workforce

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sunpride.field.ui.*
import com.sunpride.field.ui.diagnosticvisit.CameraPreview
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import com.sunpride.field.ui.diagnosticvisit.captureOrUnavailable
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** F-209/F-222: actual camera/location, never continuous-tracking consent. */
@Composable
fun WorkforceScreen(controller: FieldController,location: VisitLocation,modifier: Modifier=Modifier) {
    val context=LocalContext.current
    val scope=rememberCoroutineScope()
    val lifetime=controller.workforceLifetime
    val view=controller.workforce
    val policy=view.policy
    var mode by remember(lifetime) { mutableStateOf<String?>(null) }
    var name by remember(lifetime,policy?.id,mode) { mutableStateOf("") }
    var answers by remember(lifetime,policy?.id,mode) { mutableStateOf<Map<String,String>>(emptyMap()) }
    var geo by remember(lifetime,policy?.id,mode) { mutableStateOf<JSONObject?>(null) }
    var jpeg by remember(lifetime,policy?.id,mode) { mutableStateOf<ByteArray?>(null) }
    var photoAt by remember(lifetime,policy?.id,mode) { mutableStateOf(0L) }
    var camera by remember(mode) { mutableStateOf<ImageCapture?>(null) }
    var taking by remember { mutableStateOf(false) }
    var locating by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    var generation by remember { mutableStateOf(0) }
    val granted=ContextCompat.checkSelfPermission(context,Manifest.permission.ACCESS_COARSE_LOCATION)==PackageManager.PERMISSION_GRANTED || !location.requiresPermission
    var locationGranted by remember { mutableStateOf(granted) }
    var cameraGranted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED) }
    fun getFix() { val request=++generation;scope.launch {
        locating=true;message=null
        try { val fix=location.captureOrUnavailable().wire;if(request==generation){geo=fix;if(fix==null)message="No location yet. Check location access and try again."} }
        finally { if(request==generation)locating=false }
    } }
    val locationPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result->locationGranted=result.values.any { it };if(locationGranted)getFix() else message="Location is needed for this capture. This does not enable tracking." }
    val cameraPermission=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { cameraGranted=it }
    LaunchedEffect(Unit) { while(true) { kotlinx.coroutines.delay(3000);controller.reloadWorkforce() } }
    LaunchedEffect(mode,locationGranted) { if(mode!=null&&mode!="workforce.clockOut"&&locationGranted)getFix() }
    fun choose(value: String) { generation++;mode=value;saved=false;message=null;locating=false }
    fun shoot() {
        val image=camera?:return
        val chosen=mode;val request=generation
        val output=ByteArrayOutputStream();val at=System.currentTimeMillis();taking=true
        image.takePicture(ImageCapture.OutputFileOptions.Builder(output).build(),ContextCompat.getMainExecutor(context),object:ImageCapture.OnImageSavedCallback {
            override fun onImageSaved(result: ImageCapture.OutputFileResults) {taking=false;if(chosen==mode&&request==generation){jpeg=output.toByteArray();photoAt=at} }
            override fun onError(exception: ImageCaptureException) {taking=false;message="Could not take the photo. Try again."}
        })
    }
    fun time(at: Long?)=at?.let { DateTimeFormatter.ofPattern("d MMM, HH:mm").format(Instant.ofEpochMilli(it).atZone(ZoneId.of("Asia/Manila"))) }?:"Not recorded"
    Column(modifier.fillMaxSize().imePadding().padding(horizontal=20.dp,vertical=16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            SectionCard("Attendance") {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    Text("Clock-in: ${time(view.clockInAt)}",Modifier.testTag("workforce-clock-in-state"))
                    Text("Clock-out: ${time(view.clockOutAt)}")
                    Text("This captures one location and photo. It does not turn on location sharing.",style=MaterialTheme.typography.bodySmall)
                    SecondaryButton("Clock in",{choose("workforce.clockIn")},Modifier.testTag("workforce-clock-in"),view.canClockIn(System.currentTimeMillis())&&!controller.busy)
                    SecondaryButton("Clock out",{choose("workforce.clockOut")},Modifier.testTag("workforce-clock-out"),view.canClockOut(System.currentTimeMillis())&&!controller.busy)
                }
            }
            SectionCard("Prospects") {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(8.dp)) {
                    Text("Capture a storefront, location and the office's KYC form. The office reviews duplicates before adding it to the approved universe.",style=MaterialTheme.typography.bodySmall)
                    SecondaryButton("New prospect",{choose("workforce.prospect")},Modifier.testTag("workforce-prospect"),policy?.let { it.valid(System.currentTimeMillis())&&it.canProspect }==true&&!controller.busy)
                }
            }
            if(policy==null)Text("Connect and refresh today's field forms. The office may need to configure this team.",Modifier.testTag("workforce-policy-missing"))
            else Text("${policy.label} · version ${policy.version}\n${policy.source}",style=MaterialTheme.typography.bodySmall)
            if(mode!=null&&policy!=null) {
                SectionCard(if(mode=="workforce.prospect")"New prospect" else if(mode=="workforce.clockIn")"Clock-in evidence" else "Close attendance day") {
                    Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                        if(mode=="workforce.prospect") {
                            OutlinedTextField(name,{name=it.take(200)},label={Text("Prospect name")},singleLine=true,modifier=Modifier.fillMaxWidth().testTag("workforce-name"),shape=SunprideTokens.shapes.small)
                            for(field in policy.fields) {
                                val value=answers[field.key].orEmpty()
                                if(field.type=="select") {
                                    Text(field.label+(if(field.required)" *" else ""),style=MaterialTheme.typography.labelLarge)
                                    field.options.forEach { option->Row(Modifier.fillMaxWidth().clickable { answers=answers+(field.key to option) }) { RadioButton(value==option,{answers=answers+(field.key to option)});Text(option,Modifier.padding(top=12.dp)) } }
                                } else OutlinedTextField(value,{answers=answers+(field.key to it.take(field.maxLength))},label={Text(field.label+(if(field.required)" *" else ""))},singleLine=field.key!="address",modifier=Modifier.fillMaxWidth().testTag("workforce-field-${field.key}"),shape=SunprideTokens.shapes.small)
                            }
                        }
                        if(mode!="workforce.clockOut") {
                            Text(when { locating->"Finding location…";geo!=null->"Location captured · accuracy ${geo!!.optDouble("accuracyMeters").toInt()} m";else->"Location not captured" },Modifier.testTag("workforce-location"))
                            SecondaryButton(if(locationGranted)"Refresh location" else "Allow location",{if(locationGranted)getFix() else locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))},Modifier.testTag("workforce-locate"),!locating&&!controller.busy)
                            if(jpeg!=null) {
                                Text("Photo captured and ready to save.",Modifier.testTag("workforce-photo-ready"))
                                SecondaryButton("Retake photo",{jpeg=null},enabled=!controller.busy)
                            } else if(cameraGranted) {
                                CameraPreview({camera=it},{message="Camera unavailable. Try allowing camera access in Settings."},Modifier.fillMaxWidth().height(220.dp),front=mode=="workforce.clockIn")
                                SecondaryButton(if(taking)"Taking photo…" else "Take photo",::shoot,Modifier.testTag("workforce-take-photo"),camera!=null&&!taking&&!controller.busy)
                            } else SecondaryButton("Allow camera",{cameraPermission.launch(Manifest.permission.CAMERA)},Modifier.testTag("workforce-allow-camera"))
                        } else Text("Clock-out records the end time. It does not stop separately consented location sharing.")
                    }
                }
            }
            if(saved)Text("Saved on this phone. Sync will send it when connected.",Modifier.testTag("workforce-saved"),color=MaterialTheme.colorScheme.primary)
            (message?:controller.error)?.let { Text(it,color=MaterialTheme.colorScheme.error) }
            if(view.entries.isNotEmpty())SectionCard("Saved forms") {
                Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    view.entries.take(20).forEach { e->Text("${e.title}\n${time(e.at)} · "+when(e.state){"done"->if(e.kind=="workforce.prospect")"Sent for office review" else "Sent";"review","held"->"Needs review — kept on this phone";"sending"->"Sending";else->"Saved on this phone"},Modifier.testTag("workforce-entry"),style=MaterialTheme.typography.bodyMedium) }
                    if(view.entries.size>20)Text("Showing the latest 20 of ${view.entries.size} saved forms.")
                    if(view.entries.any { it.state in setOf("review","held") })Text("Some review work may exist only on this phone. Ask the office to reconcile before recapturing it.",style=MaterialTheme.typography.bodySmall)
                }
            }
            Spacer(Modifier.height(16.dp))
        }
        if(mode!=null)PrimaryBottomButton(if(controller.busy)"Saving…" else if(mode=="workforce.prospect")"Save prospect on phone" else if(mode=="workforce.clockIn")"Save clock-in on phone" else "Save clock-out on phone",{
            controller.saveWorkforce(mode!!,name,answers,geo,jpeg,photoAt) {saved=true;mode=null;generation++}
        },Modifier.testTag("workforce-save"),!controller.busy&&!taking&&policy?.valid(System.currentTimeMillis())==true&&(mode=="workforce.clockOut"||(geo!=null&&jpeg!=null)))
    }
}
