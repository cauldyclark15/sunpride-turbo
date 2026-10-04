package com.sunpride.field.ui.diagnosticvisit

import android.Manifest
import android.content.pm.PackageManager
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.SunprideTokens
import java.io.ByteArrayOutputStream

/** Instrumentation-only seam: a fixed JPEG instead of the camera. Always null in production. */
internal object PhotoCameraSeam {
    @Volatile var fake: (() -> ByteArray)? = null
}

/**
 * AND-016: choose the photo type, take the photo with CameraX, keep it. The JPEG is sealed on the
 * phone immediately; nothing here waits for a network, so taking photos never holds up the call.
 */
@Composable
fun PhotoCaptureScreen(controller: FieldController, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val fake = PhotoCameraSeam.fake
    var type by remember { mutableStateOf<String?>(null) }
    var capture by remember { mutableStateOf<ImageCapture?>(null) }
    var taking by remember { mutableStateOf(false) }
    var cameraError by remember { mutableStateOf<String?>(null) }
    var granted by remember { mutableStateOf(fake != null || ContextCompat.checkSelfPermission(context,
        Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) }
    var asked by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        granted = it; asked = true
    }
    /** Saved under the type chosen when the shutter was pressed. */
    fun keep(chosen: String, bytes: ByteArray, at: Long) = controller.savePhoto(chosen, bytes, at)
    fun shoot() {
        val chosen = type ?: return
        if (taking || controller.busy) return
        fake?.let { keep(chosen, it(), System.currentTimeMillis()); return }
        val camera = capture ?: return
        taking = true; cameraError = null
        val out = ByteArrayOutputStream()
        val at = System.currentTimeMillis()
        // Written to memory, never to shared storage or the gallery; CameraX records EXIF orientation.
        camera.takePicture(ImageCapture.OutputFileOptions.Builder(out).build(), ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(output: ImageCapture.OutputFileResults) {
                    taking = false
                    keep(chosen, out.toByteArray(), at)
                }
                override fun onError(exception: ImageCaptureException) {
                    taking = false; cameraError = "Couldn't take the photo. Try again."
                }
            })
    }
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SectionCard("Photo type") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    controller.photoTypeChoices().forEach { option ->
                        ChoiceRow(option.label, type == option.code, { type = option.code },
                            Modifier.testTag("photo-type-${option.code}"), !controller.busy && !taking)
                    }
                }
            }
            Box(Modifier.fillMaxWidth().aspectRatio(3f / 4f).clip(SunprideTokens.shapes.small).testTag("photo-preview"),
                contentAlignment = Alignment.Center) {
                when {
                    fake != null -> Text("Test camera", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    granted -> CameraPreview({ capture = it }, { cameraError = "Camera unavailable on this phone." },
                        Modifier.fillMaxSize())
                    else -> Column(horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp), modifier = Modifier.padding(16.dp)) {
                        Text(if (asked) "Camera access is off. Allow it in Settings to take visit photos."
                            else "Allow camera access to take visit photos.",
                            style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("camera-permission"))
                        com.sunpride.field.ui.SecondaryButton("Allow camera", { permission.launch(Manifest.permission.CAMERA) },
                            Modifier.testTag("camera-allow"))
                    }
                }
            }
            Text("Photos stay on this phone, locked, until they upload. You can end the call before they do.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            (cameraError ?: controller.diagnosticError)?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("photo-error"))
            }
            androidx.compose.foundation.layout.Spacer(Modifier.height(16.dp))
        }
        androidx.compose.foundation.layout.Spacer(Modifier.height(12.dp))
        PrimaryBottomButton(if (taking) "Taking photo…" else "Take photo", { shoot() }, Modifier.testTag("photo-take"),
            type != null && !taking && !controller.busy && (fake != null || capture != null))
    }
}

@Composable
private fun CameraPreview(onReady: (ImageCapture) -> Unit, onFailed: () -> Unit, modifier: Modifier) {
    val context = LocalContext.current
    val owner = androidx.lifecycle.compose.LocalLifecycleOwner.current
    val view = remember { PreviewView(context).apply {
        scaleType = PreviewView.ScaleType.FILL_CENTER
        implementationMode = PreviewView.ImplementationMode.COMPATIBLE
    } }
    DisposableEffect(owner) {
        val future = ProcessCameraProvider.getInstance(context)
        var provider: ProcessCameraProvider? = null
        future.addListener({
            try {
                val cameras = future.get().also { provider = it }
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(view.surfaceProvider) }
                // About 2 MP JPEG at quality 85: legible shelves and price tags, well under the 10 MB limit.
                val still = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .setJpegQuality(85)
                    .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(
                        ResolutionStrategy(Size(1600, 1200), ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build())
                    .build()
                cameras.unbindAll()
                cameras.bindToLifecycle(owner, CameraSelector.DEFAULT_BACK_CAMERA, preview, still)
                onReady(still)
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { onFailed() }
        }, ContextCompat.getMainExecutor(context))
        onDispose { provider?.unbindAll() }
    }
    AndroidView({ view }, modifier)
}
