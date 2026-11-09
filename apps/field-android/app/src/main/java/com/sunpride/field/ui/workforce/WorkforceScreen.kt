package com.sunpride.field.ui.workforce

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
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
    Column(modifier.fillMaxSize().imePadding()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start=16.dp,end=16.dp,top=4.dp,bottom=16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            SectionCard("Attendance") {
                Column(Modifier.padding(start=16.dp,end=16.dp,bottom=16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                    Row(horizontalArrangement=Arrangement.spacedBy(10.dp)) {
                        AttendanceTile("Clock in",time(view.clockInAt),view.clockInAt!=null,Modifier.weight(1f).testTag("workforce-clock-in-state"))
                        AttendanceTile("Clock out",time(view.clockOutAt),view.clockOutAt!=null,Modifier.weight(1f))
                    }
                    Text("This captures one location and photo. It does not turn on location sharing.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                        TonalButton("Clock in",{choose("workforce.clockIn")},Modifier.weight(1f).testTag("workforce-clock-in"),view.canClockIn(System.currentTimeMillis())&&!controller.busy,glyph=GlyphKind.CLOCK)
                        TonalButton("Clock out",{choose("workforce.clockOut")},Modifier.weight(1f).testTag("workforce-clock-out"),view.canClockOut(System.currentTimeMillis())&&!controller.busy,glyph=GlyphKind.CLOCK)
                    }
                }
            }
            SectionCard("Prospects") {
                Column(Modifier.padding(start=16.dp,end=16.dp,bottom=16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                    Text("Storefront photo, location and details. The office checks it.",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant)
                    TonalButton("Add prospect",{choose("workforce.prospect")},Modifier.fillMaxWidth().testTag("workforce-prospect"),policy?.let { it.valid(System.currentTimeMillis())&&it.canProspect }==true&&!controller.busy,glyph=GlyphKind.PLUS)
                }
            }
            if(policy==null)NoticeCard("Connect and refresh today's field forms. The office may need to configure this team.",tone=Look.Tone.WARN,textTag="workforce-policy-missing")
            else Text("${policy.label} · version ${policy.version}\n${policy.source}",style=MaterialTheme.typography.bodySmall,color=MaterialTheme.colorScheme.onSurfaceVariant,modifier=Modifier.padding(horizontal=4.dp))
            if(mode!=null&&policy!=null) {
                SectionCard(if(mode=="workforce.prospect")"Add prospect" else if(mode=="workforce.clockIn")"Clock-in evidence" else "Close attendance day") {
                    Column(Modifier.padding(start=16.dp,end=16.dp,bottom=16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                        if(mode=="workforce.prospect") {
                            FieldTextField(name,{name=it.take(200)},label={Text("Prospect name")},singleLine=true,modifier=Modifier.fillMaxWidth().testTag("workforce-name"))
                            for(field in policy.fields) {
                                val value=answers[field.key].orEmpty()
                                if(field.type=="select") {
                                    Text(field.label+(if(field.required)" *" else ""),style=MaterialTheme.typography.labelLarge)
                                    androidx.compose.foundation.layout.FlowRow(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                                        field.options.forEach { option->FilterPill(option,value==option,{answers=answers+(field.key to option)}) }
                                    }
                                } else FieldTextField(value,{answers=answers+(field.key to it.take(field.maxLength))},label={Text(field.label+(if(field.required)" *" else ""))},singleLine=field.key!="address",modifier=Modifier.fillMaxWidth().testTag("workforce-field-${field.key}"))
                            }
                        }
                        if(mode!="workforce.clockOut") {
                            StatusChip(when { locating->"Finding location…";geo!=null->"Location captured · accuracy ${geo!!.optDouble("accuracyMeters").toInt()} m";else->"Location not captured" },if(geo!=null)Look.Tone.GOOD else if(locating)Look.Tone.NEUTRAL else Look.Tone.WARN,textTag="workforce-location")
                            TonalButton(if(locationGranted)"Refresh location" else "Allow location",{if(locationGranted)getFix() else locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION,Manifest.permission.ACCESS_COARSE_LOCATION))},Modifier.fillMaxWidth().testTag("workforce-locate"),!locating&&!controller.busy,glyph=GlyphKind.PIN)
                            if(jpeg!=null) {
                                StatusChip("Photo captured and ready to save.",Look.Tone.GOOD,textTag="workforce-photo-ready")
                                SecondaryButton("Retake photo",{jpeg=null},Modifier.fillMaxWidth(),enabled=!controller.busy)
                            } else if(cameraGranted) {
                                CameraPreview({camera=it},{message="Camera unavailable. Try allowing camera access in Settings."},Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(20.dp)),front=mode=="workforce.clockIn")
                                TonalButton(if(taking)"Taking photo…" else "Take photo",::shoot,Modifier.fillMaxWidth().testTag("workforce-take-photo"),camera!=null&&!taking&&!controller.busy,glyph=GlyphKind.CAMERA)
                            } else TonalButton("Allow camera",{cameraPermission.launch(Manifest.permission.CAMERA)},Modifier.fillMaxWidth().testTag("workforce-allow-camera"),glyph=GlyphKind.CAMERA)
                        } else Text("Clock-out records the end time. It does not stop separately consented location sharing.",style=MaterialTheme.typography.bodyMedium)
                    }
                }
            }
            if(saved)NoticeCard("Saved on this phone. Sync will send it when connected.",tone=Look.Tone.GOOD,glyph=GlyphKind.CHECK,textTag="workforce-saved")
            (message?:controller.error)?.let { NoticeCard(it,tone=Look.Tone.BAD) }
            if(view.entries.isNotEmpty())SectionCard("Saved forms") {
                Column(Modifier.padding(start=16.dp,end=16.dp,bottom=14.dp),verticalArrangement=Arrangement.spacedBy(10.dp)) {
                    view.entries.take(20).forEach { e->Text("${e.title}\n${time(e.at)} · "+when(e.state){"done"->if(e.kind=="workforce.prospect")"Sent for office review" else "Sent";"review","held"->"Needs review — kept on this phone";"sending"->"Sending";else->"Saved on this phone"},Modifier.testTag("workforce-entry"),style=MaterialTheme.typography.bodyMedium) }
                    if(view.entries.size>20)Text("Showing the latest 20 of ${view.entries.size} saved forms.")
                    if(view.entries.any { it.state in setOf("review","held") })Text("Some review work may exist only on this phone. Ask the office to reconcile before recapturing it.",style=MaterialTheme.typography.bodySmall)
                }
            }
        }
        if(mode!=null)ActionBar { PrimaryBottomButton(if(controller.busy)"Saving…" else "Save",{
            controller.saveWorkforce(mode!!,name,answers,geo,jpeg,photoAt) {saved=true;mode=null;generation++}
        },Modifier.testTag("workforce-save"),!controller.busy&&!taking&&policy?.valid(System.currentTimeMillis())==true&&(mode=="workforce.clockOut"||(geo!=null&&jpeg!=null))) }
    }
}

@Composable
private fun AttendanceTile(label: String, value: String, recorded: Boolean, modifier: Modifier = Modifier) {
    Column(modifier.clip(RoundedCornerShape(16.dp)).background(Look.fill(if(recorded)Look.Tone.GOOD else Look.Tone.NEUTRAL)).padding(horizontal=14.dp,vertical=12.dp),
        verticalArrangement=Arrangement.spacedBy(2.dp)) {
        Text(label,style=MaterialTheme.typography.labelMedium,color=Look.text(if(recorded)Look.Tone.GOOD else Look.Tone.NEUTRAL))
        Text(value,style=MaterialTheme.typography.titleSmall,color=Look.text(if(recorded)Look.Tone.GOOD else Look.Tone.NEUTRAL))
    }
}
