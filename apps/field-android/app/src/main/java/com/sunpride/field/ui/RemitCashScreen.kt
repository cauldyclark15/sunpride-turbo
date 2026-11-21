package com.sunpride.field.ui

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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.sunpride.field.remit.RemitCash
import com.sunpride.field.ui.diagnosticvisit.CameraPreview
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

/** Receipt photo for Finance: longest side ≤ 1024 px, JPEG ≤ 64 KiB (the server's limits). */
internal fun receiptJpeg(bytes: ByteArray): ByteArray {
    val source = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size)) { "Could not read the photo" }
    try {
        for (side in listOf(RemitCash.MAX_SIDE, 800, 640)) {
            val ratio = minOf(1.0, side.toDouble() / maxOf(source.width, source.height))
            val scaled = Bitmap.createScaledBitmap(source, (source.width * ratio).toInt().coerceAtLeast(32),
                (source.height * ratio).toInt().coerceAtLeast(32), true)
            try {
                for (quality in listOf(80, 65, 50, 40)) {
                    val out = ByteArrayOutputStream(); scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
                    if (out.size() <= RemitCash.MAX_PHOTO_BYTES) return out.toByteArray()
                }
            } finally { if (scaled !== source) scaled.recycle() }
        }
        error("Retake the receipt photo closer, with only the receipt in view")
    } finally { source.recycle() }
}

/** More > Remit cash (SP-0228): amount, where it was sent, reference, when, receipt photo and a note. */
@Composable
fun RemitCashScreen(c: FieldController, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var formId by rememberSaveable { mutableStateOf(UUID.randomUUID().toString()) }
    var amount by rememberSaveable(formId) { mutableStateOf("") }
    var channel by rememberSaveable(formId) { mutableStateOf<String?>(null) }
    var other by rememberSaveable(formId) { mutableStateOf("") }
    var reference by rememberSaveable(formId) { mutableStateOf("") }
    var at by rememberSaveable(formId) { mutableStateOf(RemitCash.nowText()) }
    var note by rememberSaveable(formId) { mutableStateOf("") }
    var jpeg by remember(formId) { mutableStateOf<ByteArray?>(null) }
    var camera by remember(formId) { mutableStateOf(false) }
    var capture by remember { mutableStateOf<ImageCapture?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember(formId) { mutableStateOf<String?>(null) }
    var saved by rememberSaveable { mutableStateOf<String?>(null) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        camera = ok; if (!ok) error = "Camera access is needed for the receipt photo."
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("remit-cash"),
        verticalArrangement = Arrangement.spacedBy(12.dp)) {
        NoticeCard(RemitCash.GUIDANCE)
        saved?.let { NoticeCard(it, tone = Look.Tone.GOOD, glyph = GlyphKind.CHECK, modifier = Modifier.testTag("remit-saved")) }
        FieldTextField(amount, { amount = it.take(20); saved = null }, Modifier.fillMaxWidth().testTag("remit-amount"),
            label = { Text("Amount remitted (₱)") }, placeholder = { Text("e.g. 50000") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
        Text("Sent through", style = MaterialTheme.typography.titleSmall)
        for ((code, label) in RemitCash.CHANNELS)
            ChoiceRow(label, channel == code, { channel = code; saved = null }, Modifier.testTag("remit-channel-$code"), enabled = !busy)
        if (channel == "other")
            FieldTextField(other, { other = it.take(80) }, Modifier.fillMaxWidth().testTag("remit-other"),
                label = { Text("Name of the remittance center") }, singleLine = true)
        FieldTextField(reference, { reference = it.take(80) }, Modifier.fillMaxWidth().testTag("remit-reference"),
            label = { Text("Reference number") }, placeholder = { Text("As printed on the receipt") }, singleLine = true)
        FieldTextField(at, { at = it.take(16) }, Modifier.fillMaxWidth().testTag("remit-when"),
            label = { Text("Date and time remitted · YYYY-MM-DD HH:MM") }, singleLine = true)
        SectionCard("Receipt photo") {
            Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                if (camera) {
                    CameraPreview({ capture = it }, { error = "Camera unavailable." },
                        Modifier.fillMaxWidth().height(320.dp).clip(RoundedCornerShape(20.dp)))
                    PrimaryBottomButton("Take receipt photo", {
                        val still = capture ?: return@PrimaryBottomButton
                        val output = ByteArrayOutputStream(); busy = true
                        still.takePicture(ImageCapture.OutputFileOptions.Builder(output).build(), ContextCompat.getMainExecutor(context),
                            object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                                    scope.launch {
                                        try { jpeg = withContext(Dispatchers.Default) { receiptJpeg(output.toByteArray()) }; camera = false; error = null }
                                        catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; error = e.message ?: "Could not prepare the photo. Try again." }
                                        finally { busy = false }
                                    }
                                }
                                override fun onError(exception: ImageCaptureException) { busy = false; error = "Could not take the photo. Try again." }
                            })
                    }, Modifier.fillMaxWidth().testTag("remit-shutter"), !busy)
                } else TonalButton(if (jpeg == null) "Open camera for the receipt" else "Retake receipt photo", {
                    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera = true
                    else permission.launch(Manifest.permission.CAMERA)
                }, Modifier.fillMaxWidth().testTag("remit-camera"), !busy, glyph = GlyphKind.CAMERA)
                jpeg?.let { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let {
                    Image(it.asImageBitmap(), "Receipt photo", Modifier.fillMaxWidth().height(220.dp).clip(RoundedCornerShape(16.dp)),
                        contentScale = ContentScale.Fit)
                } }
            }
        }
        FieldTextField(note, { note = it.take(500) }, Modifier.fillMaxWidth().testTag("remit-note"),
            label = { Text("Note (optional)") }, minLines = 2)
        error?.let { NoticeCard(it, tone = Look.Tone.BAD, modifier = Modifier.testTag("remit-error")) }
        c.error?.let { NoticeCard(it, tone = Look.Tone.BAD) }
        FieldButton({
            error = null
            val payload = try {
                RemitCash.payload(formId, amount, channel, other, reference, at, note, jpeg)
            } catch (e: IllegalArgumentException) { error = e.message; return@FieldButton }
            scope.launch {
                c.queueDomain(RemitCash.KIND, payload, formId).join()
                if (c.error == null) { saved = RemitCash.SAVED; formId = UUID.randomUUID().toString() }
            }
        }, Modifier.fillMaxWidth().testTag("remit-save"), enabled = !busy && !c.busy, primary = true) { Text("Save remittance") }
        Text("Finance sees the remittance with your receipt and confirms it. Keep the paper receipt.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(24.dp))
    }
}
