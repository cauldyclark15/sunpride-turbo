package com.sunpride.field.census

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.FieldTextField
import com.sunpride.field.ui.SectionCard
import java.io.ByteArrayOutputStream
import java.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

@Composable
fun EnrollmentFieldsSection(fields: List<EnrollmentFields.Field>, form: CustomerCapture.Form,
    onChange: (CustomerCapture.Form) -> Unit, errors: Map<String,String>, enabled: Boolean, onBusyChange: (Boolean) -> Unit) {
    if (fields.isEmpty()) return
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val current by rememberUpdatedState(form)
    val change by rememberUpdatedState(onChange)
    var target by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(false) }
    fun set(key: String, value: String) { change(current.copy(customFields = current.customFields + (key to value))) }
    fun photo(load: () -> Bitmap?) {
        val key = target ?: return
        loading = true; onBusyChange(true)
        scope.launch {
            try {
                val encoded = withContext(Dispatchers.IO) {
                    val bitmap = requireNotNull(load())
                    val scale = minOf(1.0, 640.0 / maxOf(bitmap.width,bitmap.height))
                    val resized = Bitmap.createScaledBitmap(bitmap,(bitmap.width*scale).toInt().coerceAtLeast(1),(bitmap.height*scale).toInt().coerceAtLeast(1),true)
                    try {
                        var result: String? = null
                        for (quality in listOf(70,50,30,15)) {
                            val out = ByteArrayOutputStream(); resized.compress(Bitmap.CompressFormat.JPEG,quality,out)
                            if (out.size() <= 100*1024) { result = "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(out.toByteArray());break }
                        }
                        requireNotNull(result)
                    } finally { if (resized !== bitmap) resized.recycle(); bitmap.recycle() }
                }
                set(key,encoded); problem = null
            } catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (_: Exception) { problem = "Could not prepare that photo. Try a smaller picture." }
            finally { loading = false; onBusyChange(false) }
        }
    }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicturePreview()) { bitmap -> if (bitmap != null) photo { bitmap } }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        if (uri != null) photo {
            val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it,null,opts) }
            require(opts.outWidth in 1..20000 && opts.outHeight in 1..20000)
            opts.inSampleSize = generateSequence(1) { it*2 }.first { maxOf(opts.outWidth,opts.outHeight)/it <= 1024 }
            opts.inJustDecodeBounds = false
            context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it,null,opts) }
        }
    }
    SectionCard("Additional information") {
        Column(Modifier.padding(16.dp),verticalArrangement=Arrangement.spacedBy(12.dp)) {
            fields.forEach { f ->
                val value = form.customFields[f.key].orEmpty()
                val label = f.label + if (f.required(form)) " *" else " (optional)"
                val tag = "customFields.${f.key}"
                when (f.kind) {
                    "boolean", "choice" -> CensusPicker(label,(if(f.kind=="boolean") listOf("true" to "Yes","false" to "No") else f.choices.map { it to it }),value,{set(f.key,it)},"customer-$tag")
                    "photo" -> {
                        Text(label)
                        Row(horizontalArrangement=Arrangement.spacedBy(8.dp)) {
                            TextButton({target=f.key;camera.launch(null)},enabled=enabled && !loading) {Text("Take photo")}
                            TextButton({target=f.key;picker.launch("image/jpeg")},enabled=enabled && !loading) {Text("Choose photo")}
                        }
                        if (value.isNotEmpty()) {
                            val bitmap = remember(value) { runCatching { val bytes=Base64.getDecoder().decode(value.substringAfter(","));BitmapFactory.decodeByteArray(bytes,0,bytes.size) }.getOrNull() }
                            bitmap?.let { Image(it.asImageBitmap(),f.label,Modifier.fillMaxWidth().height(120.dp)) }
                            TextButton({set(f.key,"")},enabled=enabled && !loading) {Text("Clear photo")}
                        }
                    }
                    else -> FieldTextField(value,{set(f.key,it.take(500))},label={Text(label)},singleLine=true,enabled=enabled && !loading,
                        placeholder=if(f.kind=="date") {{Text("YYYY-MM-DD")}} else null,
                        keyboardOptions=androidx.compose.foundation.text.KeyboardOptions(keyboardType=if(f.kind=="number") androidx.compose.ui.text.input.KeyboardType.Decimal else androidx.compose.ui.text.input.KeyboardType.Text),
                        isError=tag in errors,modifier=Modifier.fillMaxWidth().testTag("customer-$tag"))
                }
                errors[tag]?.let {Text(it,color=MaterialTheme.colorScheme.error)}
            }
            problem?.let {Text(it,color=MaterialTheme.colorScheme.error)}
        }
    }
}
