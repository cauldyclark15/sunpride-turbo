package com.sunpride.field.census

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import com.sunpride.field.ui.FieldBackend
import com.sunpride.field.ui.SecondaryButton
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun TagStoreLocation(backend: FieldBackend?, outletId: String? = null, captureId: String? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var message by remember(outletId, captureId) { mutableStateOf(StoreLocationTag.MISSING) }
    fun start() { scope.launch {
        message = try { withContext(Dispatchers.IO) { requireNotNull(backend).tagStoreLocation(captureId, outletId) }; "Trying GPS for up to 15 minutes. The reading stays on this phone until it can send." }
        catch (_: Exception) { "Could not start tagging. Refresh your access and try again." }
    } }
    val permission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.ACCESS_FINE_LOCATION] == true) start() else message = "Allow precise location to tag this store. You can still save without it."
    }
    Text(message)
    SecondaryButton("Tag location now", {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) start()
        else permission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    })
    Text(StoreLocationTag.TIP)
}
