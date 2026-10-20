package com.sunpride.field.retail

import android.Manifest
import android.content.pm.PackageManager
import android.os.SystemClock
import android.util.Size
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.core.resolutionselector.ResolutionSelector
import androidx.camera.core.resolutionselector.ResolutionStrategy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.sunpride.field.ui.SecondaryButton
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** F-315: bounded on-device camera analysis, disposed on close; no frame leaves the phone. */
@Composable fun EquipmentSerialScanner(onScan:(String)->Unit,onClose:()->Unit) {
    val context=LocalContext.current;val owner=LocalLifecycleOwner.current
    var granted by remember { mutableStateOf(ContextCompat.checkSelfPermission(context,Manifest.permission.CAMERA)==PackageManager.PERMISSION_GRANTED) }
    var message by remember { mutableStateOf("Point the camera at the equipment barcode or QR label.") }
    val latestScan by rememberUpdatedState(onScan)
    val request=rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()){granted=it;if(!it) message="Camera access is off. You can enter the serial instead."}
    val view=remember{PreviewView(context).apply{implementationMode=PreviewView.ImplementationMode.COMPATIBLE}}
    Dialog(onDismissRequest=onClose) {
        Surface {
            Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
                Text("Scan equipment serial")
                if(granted) {
                    DisposableEffect(owner,view) {
                        val main=ContextCompat.getMainExecutor(context);val worker=Executors.newSingleThreadExecutor()
                        val decoder=EquipmentBarcodeDecoder();val finished=AtomicBoolean(false);val disposed=AtomicBoolean(false)
                        val future=ProcessCameraProvider.getInstance(context);var provider:ProcessCameraProvider?=null
                        val preview=Preview.Builder().build().also{it.setSurfaceProvider(view.surfaceProvider)}
                        val analysis=ImageAnalysis.Builder().setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                            .setResolutionSelector(ResolutionSelector.Builder().setResolutionStrategy(ResolutionStrategy(Size(640,480),ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER)).build()).build()
                        var last=0L
                        analysis.setAnalyzer(worker){ image ->
                            try {
                                val at=SystemClock.elapsedRealtime()
                                if(!disposed.get()&&!finished.get()&&at-last>=500){
                                    last=at;val plane=image.planes[0];val packed=EquipmentBarcodeDecoder.pack(plane.buffer,image.width,image.height,plane.rowStride,plane.pixelStride)
                                    val result=decoder.decode(packed,image.width,image.height)
                                    if(!result.isNullOrBlank()&&result.length<=200&&finished.compareAndSet(false,true)) main.execute{if(!disposed.get())latestScan(result)}
                                }
                            } finally {image.close()}
                        }
                        future.addListener({if(!disposed.get())try{provider=future.get();provider?.bindToLifecycle(owner,CameraSelector.DEFAULT_BACK_CAMERA,preview,analysis)}catch(_:Exception){message="Camera unavailable. Close and enter the serial instead."}},main)
                        onDispose{disposed.set(true);analysis.clearAnalyzer();provider?.unbind(preview,analysis);worker.shutdownNow()}
                    }
                    AndroidView(factory={view},modifier=Modifier.fillMaxWidth().height(300.dp).testTag("equipment-scan-preview"))
                } else SecondaryButton("Allow camera",{request.launch(Manifest.permission.CAMERA)})
                Text(message)
                SecondaryButton("Close scanner",onClose,Modifier.fillMaxWidth())
            }
        }
    }
}
