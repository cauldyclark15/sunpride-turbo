package com.sunpride.van.scanning

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBars
import androidx.compose.material3.Button
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Runtime CAMERA permission + lifecycle-bound CameraX/ZXing fallback; no network/Play services. */
@Composable
fun CameraScanScreen(onCode: (String) -> Unit, onClose: () -> Unit, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val latestCode by rememberUpdatedState(onCode)
    var permitted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    var message by remember { mutableStateOf("Point the camera at a barcode or QR code") }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        permitted = it
        if (!it) message = "Camera permission is denied. Use the handheld scanner or grant permission in app settings."
    }
    LaunchedEffect(Unit) { if (!permitted) permission.launch(Manifest.permission.CAMERA) }
    BackHandler(onBack = onClose)
    val previewView = remember(context) { PreviewView(context) }
    DisposableEffect(permitted, lifecycleOwner, previewView) {
        val disposed = AtomicBoolean(false)
        val delivered = AtomicBoolean(false)
        val executor = Executors.newSingleThreadExecutor()
        val main = ContextCompat.getMainExecutor(context)
        val decoder = CameraBarcodeDecoder()
        var provider: ProcessCameraProvider? = null
        val preview = Preview.Builder().build().apply { surfaceProvider = previewView.surfaceProvider }
        val analysis = ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
        if (permitted) {
            analysis.setAnalyzer(executor) { image ->
                try {
                    if (!disposed.get() && !delivered.get()) {
                        val plane = image.planes[0]
                        val y = CameraBarcodeDecoder.packLuminance(plane.buffer, image.width, image.height, plane.rowStride, plane.pixelStride)
                        val result = decoder.decode(y, image.width, image.height)
                            ?: decoder.decode(CameraBarcodeDecoder.rotateClockwise(y, image.width, image.height), image.height, image.width)
                        if (result != null && delivered.compareAndSet(false, true)) {
                            main.execute { if (!disposed.get()) latestCode(result) }
                        }
                    }
                } catch (_: Exception) {
                    // A malformed/transient camera frame must not terminate analysis or leak ImageProxy.
                } finally { image.close() }
            }
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                if (!disposed.get()) try {
                    provider = future.get()
                    provider?.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                } catch (_: Exception) {
                    message = "Camera unavailable. Use the handheld scanner."
                }
            }, main)
        }
        onDispose {
            disposed.set(true)
            analysis.clearAnalyzer()
            provider?.unbind(preview, analysis) // Do not unbind other screens' use cases.
            executor.shutdown()
        }
    }
    Scaffold(modifier = modifier, contentWindowInsets = WindowInsets.systemBars) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text("Scan with camera")
            Text(message)
            if (permitted) AndroidView(factory = { previewView }, modifier = Modifier.fillMaxWidth().weight(1f))
            else Button(onClick = { permission.launch(Manifest.permission.CAMERA) }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) {
                Text("Allow camera")
            }
            Button(onClick = onClose, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp)) { Text("Back to printer & scanner") }
        }
    }
}
