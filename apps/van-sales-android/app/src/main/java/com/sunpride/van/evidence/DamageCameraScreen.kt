package com.sunpride.van.evidence

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.*
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.van.ui.PrimaryBottomButton
import com.sunpride.van.ui.SecondaryButton
import java.util.concurrent.atomic.AtomicBoolean

/** Reuses the scanner's CameraX dependencies. JPEG stays in memory until compressed into noBackup storage. */
/** F-312: one-shot photo location is independent of continuous trip-sharing consent. */
internal fun executionPhotoPermissionsGranted(camera: Boolean, fineLocation: Boolean, requireLocation: Boolean) =
    camera && (!requireLocation || fineLocation)

@Composable fun DamageCameraScreen(onCaptured: (DamageCapture) -> Unit, onClose: () -> Unit, requireLocation: Boolean = true, title: String = "Damage photo", instructions: String? = null) {
    val context = LocalContext.current
    val owner = LocalLifecycleOwner.current
    fun granted(permission: String) = ContextCompat.checkSelfPermission(context,permission) == PackageManager.PERMISSION_GRANTED
    fun allowed() = executionPhotoPermissionsGranted(granted(Manifest.permission.CAMERA),granted(Manifest.permission.ACCESS_FINE_LOCATION),requireLocation)
    val required = remember(requireLocation) { if (requireLocation) arrayOf(Manifest.permission.CAMERA,Manifest.permission.ACCESS_COARSE_LOCATION,Manifest.permission.ACCESS_FINE_LOCATION) else arrayOf(Manifest.permission.CAMERA) }
    var permitted by remember(requireLocation) { mutableStateOf(allowed()) }
    var message by remember { mutableStateOf(instructions ?: if (requireLocation) "Show the damaged goods clearly. Precise location stamps this photo; your trip-sharing choice is unchanged." else "Show the damaged goods clearly — SAMPLE practice capture") }
    var ready by remember { mutableStateOf(false) }
    var capturing by remember { mutableStateOf(false) }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        permitted = allowed()
        if (!permitted) message = if (requireLocation) "Allow camera and precise location in app settings, then try again. A photo cannot be saved without its capture location." else "Camera permission is denied. Allow camera in app settings to take a photo."
    }
    LaunchedEffect(requireLocation) { if (!permitted) permission.launch(required) }
    val view = remember { PreviewView(context) }
    val capture = remember { ImageCapture.Builder().setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY).build() }
    val alive = remember { AtomicBoolean(true) }
    val latestCaptured by rememberUpdatedState(onCaptured)
    val main = ContextCompat.getMainExecutor(context)
    DisposableEffect(permitted,owner) {
        alive.set(true)
        var provider: ProcessCameraProvider? = null
        val disposed = AtomicBoolean(false)
        val preview = Preview.Builder().build().apply { surfaceProvider = view.surfaceProvider }
        if (permitted) {
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({ if (!disposed.get()) try {
                provider = future.get()
                provider?.bindToLifecycle(owner,CameraSelector.DEFAULT_BACK_CAMERA,preview,capture)
                ready = true
            } catch (_: Exception) { message = "Camera unavailable. Try again or cancel." } },main)
        }
        onDispose { disposed.set(true); alive.set(false); ready = false; provider?.unbind(preview,capture) }
    }
    Column(Modifier.fillMaxSize().safeDrawingPadding().padding(16.dp),verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(title,style = MaterialTheme.typography.titleLarge)
        Text(message)
        if (permitted) AndroidView(factory = { view },modifier = Modifier.fillMaxWidth().weight(1f))
        else { Spacer(Modifier.weight(1f)); SecondaryButton(if (requireLocation) "Allow camera & location" else "Allow camera",{ permission.launch(required) }) }
        PrimaryBottomButton("Capture photo",{
            capturing = true
            capture.takePicture(main,object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    try {
                        if (alive.get()) {
                            val buffer = image.planes[0].buffer
                            val jpeg = ByteArray(buffer.remaining()).also { buffer.get(it) }
                            latestCaptured(DamageCapture(jpeg,image.imageInfo.rotationDegrees))
                        }
                    } finally { image.close() }
                }
                override fun onError(exception: ImageCaptureException) {
                    if (alive.get()) { capturing = false; message = "Could not take photo. Try again." }
                }
            })
        },permitted && ready && !capturing,"damage-capture")
        SecondaryButton("Cancel photo",onClose,enabled = !capturing)
    }
}
