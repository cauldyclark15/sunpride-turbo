package com.sunpride.field.census

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import com.sunpride.field.ui.ActionBar
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.FieldTextField
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.NoticeCard
import com.sunpride.field.ui.PickerField
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.StatusChip
import com.sunpride.field.ui.TonalButton
import com.sunpride.field.ui.diagnosticvisit.CameraPreview
import com.sunpride.field.ui.diagnosticvisit.VisitLocation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Base64

/** F-011 complete offline survey, independently queued from selling calls. */
@Composable
fun CensusScreen(backend: FieldBackend?, location: VisitLocation, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var config by remember { mutableStateOf<JSONObject?>(null) }
    var history by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var message by remember { mutableStateOf("Loading census setup…") }
    var busy by remember { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }; var address by rememberSaveable { mutableStateOf("") }
    var owner by rememberSaveable { mutableStateOf("") }; var phone by rememberSaveable { mutableStateOf("") }
    var batch by rememberSaveable { mutableStateOf("") }; var channel by rememberSaveable { mutableStateOf("") }
    var subchannel by rememberSaveable { mutableStateOf("") }; var estimatedClass by rememberSaveable { mutableStateOf("D") }
    var fix by remember { mutableStateOf<JSONObject?>(null) }; var jpeg by remember { mutableStateOf<ByteArray?>(null) }
    var camera by remember { mutableStateOf(false) }; var capture by remember { mutableStateOf<ImageCapture?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it; if (!it) message = "Camera access is needed for the storefront photo." }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        message = "Tap Get GPS fix again after allowing precise location."
    }
    LaunchedEffect(backend) {
        try {
            config = withContext(Dispatchers.IO) { backend?.censusConfig() }
            history = withContext(Dispatchers.IO) { backend?.censusHistory().orEmpty() }
            message = if (config == null) "Connect once to download your census batches, then capture offline." else "Saved captures stay encrypted on this phone until the next sync."
        } catch (_: Exception) { message = "Census setup is unavailable. Connect and refresh your signed-in account." }
    }
    fun choices(key: String): List<Pair<String, String>> = config?.optJSONArray(key)?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.filter { key != "subchannels" || it.getJSONObject("data").getString("channelId") == channel }
            .map { it.getString("id") to it.optString("label", it.optString("name")) }
    }.orEmpty()
    fun save() {
        val backendNow = backend ?: return
        scope.launch {
            busy = true
            try {
                val now = System.currentTimeMillis()
                val p = JSONObject().put("captureId", CensusRules.captureId()).put("batchId", batch).put("name", name.trim())
                    .put("address", address.trim()).put("ownerName", owner.trim()).put("ownerPhone", phone.trim())
                    .put("channelId", channel).put("subchannelId", subchannel).put("estimatedClass", estimatedClass)
                    .put("deviceTime", now).put("location", fix ?: JSONObject.NULL)
                    .put("photoJpegBase64", jpeg?.let { Base64.getEncoder().encodeToString(it) } ?: "")
                CensusRules.validate(p)
                withContext(Dispatchers.IO) { backendNow.queueCensus(p) }
                history = withContext(Dispatchers.IO) { backendNow.censusHistory() }
                message = "Census saved on this phone. It will be reviewed after sync."
                name = ""; address = ""; owner = ""; phone = ""; fix = null; jpeg = null
            } catch (e: Exception) { message = if (e is IllegalArgumentException) e.message ?: "Complete every census field." else "Could not save. Check your offline recording access and retry." }
            finally { busy = false }
        }
    }
    Column(modifier.fillMaxSize().imePadding()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            NoticeCard(message, tone = if (config == null) Look.Tone.WARN else Look.Tone.NEUTRAL,
                glyph = if (config == null) GlyphKind.INFO else GlyphKind.LOCK, textTag = "census-message")
            SectionCard("Store") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CensusPicker("Census batch", choices("batches"), batch, { batch = it }, "census-batch",
                        empty = if (config == null) "Not downloaded yet" else "No batches assigned")
                    FieldTextField(name, { name = it }, label = { Text("Store name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-name"))
                    FieldTextField(address, { address = it }, label = { Text("Address") }, modifier = Modifier.fillMaxWidth().testTag("census-address"))
                }
            }
            SectionCard("Owner") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    FieldTextField(owner, { owner = it }, label = { Text("Owner contact name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-owner"))
                    FieldTextField(phone, { phone = it }, label = { Text("Owner phone") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-phone"),
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Phone))
                }
            }
            SectionCard("Channel") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    CensusPicker("Channel", choices("channels"), channel, { channel = it; subchannel = "" }, "census-channel")
                    CensusPicker("Sub-channel", choices("subchannels"), subchannel, { subchannel = it }, "census-subchannel",
                        empty = if (channel.isEmpty()) "Choose a channel first" else "Choose…")
                    CensusPicker("Estimated revenue-potential class", listOf("A", "B", "C", "D").map { it to "Class $it" }, estimatedClass, { estimatedClass = it }, "census-class")
                }
            }
            SectionCard("Location and photo") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    TonalButton("Get GPS fix", {
                        if (location.requiresPermission && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED)
                            locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
                        else scope.launch { busy = true; try { fix = location.fixWithinAccuracy(50.0); message = if (fix == null) "No GPS fix. Move outside and retry." else "GPS accuracy ±${fix!!.getDouble("accuracyMeters").toInt()} m. Must be under 50 m." } finally { busy = false } }
                    }, Modifier.fillMaxWidth().testTag("census-gps"), !busy, glyph = GlyphKind.PIN)
                    fix?.let { StatusChip("GPS ±${it.getDouble("accuracyMeters").toInt()} m", Look.Tone.GOOD, textTag = "census-accuracy") }
                    if (camera) {
                        CameraPreview({ capture = it }, { message = "Camera unavailable." }, Modifier.fillMaxWidth().height(260.dp).clip(RoundedCornerShape(20.dp)))
                        PrimaryBottomButton("Take storefront photo", {
                            val still = capture ?: return@PrimaryBottomButton
                            val output = ByteArrayOutputStream(); busy = true
                            still.takePicture(ImageCapture.OutputFileOptions.Builder(output).build(), ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                                    scope.launch { try { jpeg = withContext(Dispatchers.Default) { boundedJpeg(output.toByteArray()) }; camera = false; message = "Storefront photo saved for this census." } catch (_: Exception) { message = "Could not prepare the photo. Try again." } finally { busy = false } }
                                }
                                override fun onError(exception: ImageCaptureException) { busy = false; message = "Could not take the photo. Try again." }
                            })
                        }, Modifier.fillMaxWidth().testTag("census-shutter"), !busy)
                    } else TonalButton(if (jpeg == null) "Open storefront camera" else "Retake storefront photo", {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera = true
                        else cameraPermission.launch(Manifest.permission.CAMERA)
                    }, Modifier.fillMaxWidth().testTag("census-camera"), !busy, glyph = GlyphKind.CAMERA)
                    jpeg?.let { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { Image(it.asImageBitmap(), "Captured storefront", Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(16.dp)), contentScale = ContentScale.Crop) } }
                }
            }
            if (history.isNotEmpty()) SectionCard("Saved census captures") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    history.takeLast(20).reversed().forEach { (store, state) ->
                        Text("$store · ${if (state == "done") "Sent for review" else if (state == "review") "Needs review" else "Saved on phone"}",
                            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("census-saved"))
                    }
                }
            }
        }
        ActionBar { PrimaryBottomButton("Save census offline", ::save, Modifier.fillMaxWidth().testTag("census-save"), !busy && config != null && !camera) }
    }
}
@Composable
private fun CensusPicker(label: String, choices: List<Pair<String, String>>, value: String, onChange: (String) -> Unit, tag: String,
    empty: String = "Choose…") {
    var expanded by remember { mutableStateOf(false) }
    Box {
        PickerField(label, choices.firstOrNull { it.first == value }?.second, empty, { expanded = true }, Modifier.testTag(tag))
        DropdownMenu(expanded, { expanded = false }) { choices.forEach { choice -> DropdownMenuItem(text = { Text(choice.second) }, onClick = { onChange(choice.first); expanded = false }) } }
    }
}
private fun boundedJpeg(bytes: ByteArray): ByteArray {
    val source = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
    val ratio = minOf(1.0, 800.0 / maxOf(source.width, source.height))
    val scaled = Bitmap.createScaledBitmap(source, (source.width * ratio).toInt().coerceAtLeast(1), (source.height * ratio).toInt().coerceAtLeast(1), true)
    try {
        for (quality in listOf(75, 60, 45, 30)) {
            val out = ByteArrayOutputStream(); scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
            if (out.size() <= CensusRules.MAX_PHOTO_BYTES) return out.toByteArray()
        }
        error("Photo exceeds capture budget")
    } finally { if (scaled !== source) scaled.recycle(); source.recycle() }
}
