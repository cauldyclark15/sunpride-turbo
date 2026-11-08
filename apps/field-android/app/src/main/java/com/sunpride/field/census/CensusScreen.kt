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
import com.sunpride.field.ui.bottomSafe
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.foundation.clickable
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.customers.CustomerRecord
import java.io.ByteArrayOutputStream
import java.util.Base64

/** F-011 complete offline survey, independently queued from selling calls.
 * SP-0163: two location choices (Use my location / Search address), landmark, duplicate warning, optional batch. */
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun CensusScreen(backend: FieldBackend?, location: VisitLocation, onBack: () -> Unit, modifier: Modifier = Modifier,
    stores: List<CustomerRecord> = emptyList(), onOpenStore: ((String) -> Unit)? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val places = remember(backend) { runCatching { backend?.censusPlaces() }.getOrNull() }
    var config by remember { mutableStateOf<JSONObject?>(null) }
    var history by remember { mutableStateOf<List<Pair<String, String>>>(emptyList()) }
    var message by remember { mutableStateOf("Loading store setup…") }
    var busy by remember { mutableStateOf(false) }
    var name by rememberSaveable { mutableStateOf("") }; var address by rememberSaveable { mutableStateOf("") }
    var owner by rememberSaveable { mutableStateOf("") }; var phone by rememberSaveable { mutableStateOf("") }
    var batch by rememberSaveable { mutableStateOf("") }; var channel by rememberSaveable { mutableStateOf("") }
    var subchannel by rememberSaveable { mutableStateOf("") }; var estimatedClass by rememberSaveable { mutableStateOf("D") }
    var landmark by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf("") } // "", "gps", "places"
    var fix by remember { mutableStateOf<JSONObject?>(null) }; var jpeg by remember { mutableStateOf<ByteArray?>(null) }
    var lastFix by remember { mutableStateOf<Pair<Double, Double>?>(null) }
    var reverse by remember { mutableStateOf<CensusPlaces.Address?>(null) }
    var autoAddress by remember { mutableStateOf<String?>(null) }
    var locationNote by remember { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var session by remember { mutableStateOf(CensusPlaces.session()) }
    var predictions by remember { mutableStateOf<List<CensusPlaces.Prediction>>(emptyList()) }
    var picked by remember { mutableStateOf<CensusPlaces.Address?>(null) }
    var searchNote by remember { mutableStateOf<String?>(null) }
    var duplicates by remember { mutableStateOf<List<DuplicateRules.Candidate>>(emptyList()) }
    var pending by remember { mutableStateOf<JSONObject?>(null) }
    var camera by remember { mutableStateOf(false) }; var capture by remember { mutableStateOf<ImageCapture?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it; if (!it) message = "Camera access is needed for the storefront photo." }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        message = "Tap Use my location again after allowing precise location."
    }
    LaunchedEffect(backend) {
        try {
            config = withContext(Dispatchers.IO) { backend?.censusConfig() }
            history = withContext(Dispatchers.IO) { backend?.censusHistory().orEmpty() }
            message = if (config == null) "Connect once to download the store setup, then add stores offline." else "Saved stores stay encrypted on this phone until the next sync."
        } catch (_: Exception) { message = "Store setup is unavailable. Connect and refresh your signed-in account." }
    }
    val searchOffered = CensusRules.addressSearch(config) && places != null
    val showBatch = CensusRules.showBatchPicker(config)
    // Contract: suggestions after 3 characters, 300 ms debounce, one session per search, biased to the last fix.
    LaunchedEffect(query, mode) {
        if (mode != "places" || places == null) return@LaunchedEffect
        val text = query.trim()
        if (text.length < 3 || text == picked?.formattedAddress) { predictions = emptyList(); return@LaunchedEffect }
        delay(300)
        when (val r = withContext(Dispatchers.IO) { places.autocomplete(text, session, lastFix?.first, lastFix?.second) }) {
            is CensusPlaces.Result.Ok -> { predictions = r.value; searchNote = if (r.value.isEmpty()) "No matching address. Try other words." else null }
            CensusPlaces.Result.Offline -> { predictions = emptyList(); searchNote = OFFLINE_SEARCH }
            CensusPlaces.Result.Unavailable -> { predictions = emptyList(); searchNote = "Address search is not available right now. Use my location instead." }
        }
    }
    fun choices(key: String): List<Pair<String, String>> = config?.optJSONArray(key)?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.filter { key != "subchannels" || it.getJSONObject("data").getString("channelId") == channel }
            .map { it.getString("id") to it.optString("label", it.optString("name")) }
    }.orEmpty()
    fun useMyLocation() {
        if (location.requiresPermission && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)); return
        }
        mode = "gps"; picked = null; predictions = emptyList()
        scope.launch {
            busy = true; locationNote = "Getting your location…"
            try {
                val got = location.fixWithinAccuracy(50.0)
                val accuracy = got?.optDouble("accuracyMeters", Double.NaN) ?: Double.NaN
                if (got == null || got.optBoolean("mockSignal") || !(accuracy > 0 && accuracy < 50)) {
                    fix = null
                    locationNote = if (got == null) "No location yet. Move outside or wait for a better signal, then try again."
                        else if (got.optBoolean("mockSignal")) "This phone is using a fake location. Turn it off and try again."
                        else "Location is only ±${accuracy.toInt()} m. Move outside or wait for a better signal, then try again."
                    return@launch
                }
                fix = got; lastFix = got.getDouble("latitude") to got.getDouble("longitude")
                locationNote = null
                when (val r = places?.let { withContext(Dispatchers.IO) { it.reverse(got.getDouble("latitude"), got.getDouble("longitude")) } }) {
                    is CensusPlaces.Result.Ok -> {
                        reverse = r.value
                        if (address.isBlank() || address == autoAddress) { address = r.value.formattedAddress; autoAddress = address }
                    }
                    CensusPlaces.Result.Offline -> { reverse = null; locationNote = "Saved with your location; the address can be fixed later. Type the address." }
                    else -> { reverse = null; locationNote = "Type the address. Your location is saved." }
                }
            } finally { busy = false }
        }
    }
    fun pick(p: CensusPlaces.Prediction) {
        val api = places ?: return
        scope.launch {
            busy = true
            try {
                when (val r = withContext(Dispatchers.IO) { api.details(p.placeId, session) }) {
                    is CensusPlaces.Result.Ok -> {
                        withContext(Dispatchers.Main.immediate) { focus.clearFocus() }; picked = r.value; predictions = emptyList(); query = r.value.formattedAddress; searchNote = null
                        address = r.value.formattedAddress; autoAddress = address; fix = null
                        session = CensusPlaces.session() // the session ends with the details call
                    }
                    CensusPlaces.Result.Offline -> searchNote = OFFLINE_SEARCH
                    CensusPlaces.Result.Unavailable -> searchNote = "Could not open that address. Try again or use my location."
                }
            } finally { busy = false }
        }
    }
    fun reset() {
        name = ""; address = ""; owner = ""; phone = ""; fix = null; jpeg = null; landmark = ""; mode = ""; picked = null
        reverse = null; autoAddress = null; query = ""; predictions = emptyList(); locationNote = null; searchNote = null
        duplicates = emptyList(); pending = null
    }
    fun queue(p: JSONObject) {
        val backendNow = backend ?: return
        scope.launch {
            busy = true
            try {
                CensusRules.validate(p)
                withContext(Dispatchers.IO) { backendNow.queueCensus(p) }
                history = withContext(Dispatchers.IO) { backendNow.censusHistory() }
                message = "Store saved on this phone. It will be reviewed after sync."
                reset()
            } catch (e: Exception) { message = if (e is IllegalArgumentException) e.message ?: "Complete every field." else "Could not save. Check your offline recording access and retry." }
            finally { busy = false }
        }
    }
    fun build(acknowledged: List<String>): JSONObject {
        val place = picked?.takeIf { mode == "places" }?.let {
            CensusRules.Place(it.placeId ?: "", it.latitude ?: Double.NaN, it.longitude ?: Double.NaN, it.formattedAddress, it.components.json())
        }
        return CensusRules.payload(CensusRules.captureId(), CensusRules.chosenBatch(showBatch, batch), name, address, owner, phone, channel, subchannel,
            estimatedClass, System.currentTimeMillis(), if (mode == "gps") fix else null, place, landmark,
            reverse?.takeIf { mode == "gps" }?.let { it.formattedAddress to it.components.json() }, acknowledged,
            jpeg?.let { Base64.getEncoder().encodeToString(it) } ?: "")
    }
    fun save() {
        backend ?: return
        scope.launch {
            busy = true
            try {
                if (mode == "") throw IllegalArgumentException("Set the location: Use my location or Search address.")
                if (mode == "places" && picked == null) throw IllegalArgumentException("Pick the address from the search list.")
                if (mode == "gps" && fix == null) throw IllegalArgumentException("Tap Use my location and wait for a good signal.")
                val draft = build(emptyList()); CensusRules.validate(draft)
                val loc = draft.getJSONObject("location")
                val query = DuplicateRules.Store("", name, phone, loc.getDouble("latitude"), loc.getDouble("longitude"), draft.optString("placeId").ifEmpty { null })
                val local = DuplicateRules.find(query, stores.map { DuplicateRules.Store(it.outletId, it.name, null, it.latitude, it.longitude, address = it.address) })
                val server = places?.let { api -> withTimeoutOrNull(5_000) { withContext(Dispatchers.IO) {
                    api.duplicateCheck(name.trim(), phone.trim(), query.latitude, query.longitude, query.placeId) } } }
                val found = DuplicateRules.merge(local, (server as? CensusPlaces.Result.Ok)?.value.orEmpty())
                busy = false
                if (found.isEmpty()) queue(draft) else { duplicates = found; pending = draft }
            } catch (e: Exception) { message = if (e is IllegalArgumentException) e.message ?: "Complete every field." else "Could not save. Check your offline recording access and retry." }
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
                    if (showBatch) CensusPicker("Gathering batch (optional)", choices("batches"), batch, { batch = it }, "census-batch",
                        empty = "Ongoing gathering (default)")
                    FieldTextField(name, { name = it }, label = { Text("Store name") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-name"))
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
            SectionCard("Location") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                        if (mode == "gps" || !searchOffered) PrimaryBottomButton("Use my location", ::useMyLocation, Modifier.weight(1f).testTag("census-gps"), !busy)
                        else TonalButton("Use my location", ::useMyLocation, Modifier.weight(1f).testTag("census-gps"), !busy, glyph = GlyphKind.PIN)
                        if (searchOffered) {
                            if (mode == "places") PrimaryBottomButton("Search address", { }, Modifier.weight(1f).testTag("census-search-mode"), !busy)
                            else TonalButton("Search address", { mode = "places"; fix = null; reverse = null; locationNote = null; session = CensusPlaces.session() },
                                Modifier.weight(1f).testTag("census-search-mode"), !busy)
                        }
                    }
                    if (mode == "gps") fix?.let { StatusChip("Your location ±${it.getDouble("accuracyMeters").toInt()} m", Look.Tone.GOOD, textTag = "census-accuracy") }
                    locationNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("census-location-note")) }
                    if (mode == "places") {
                        FieldTextField(query, { query = it.take(120); if (picked != null && it != picked?.formattedAddress) picked = null },
                            label = { Text("Search address or place") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-search"))
                        // Keep suggestions above the keyboard on small phones.
                        val suggestionsView = remember { BringIntoViewRequester() }
                        LaunchedEffect(predictions, searchNote) { if (predictions.isNotEmpty() || searchNote != null) { delay(50); suggestionsView.bringIntoView() } }
                        Column(Modifier.fillMaxWidth().bringIntoViewRequester(suggestionsView)) {
                        predictions.forEach { p ->
                            Column(Modifier.fillMaxWidth().clickable(enabled = !busy) { pick(p) }.padding(vertical = 8.dp).testTag("census-suggestion")) {
                                Text(p.primary.ifEmpty { p.description }, style = MaterialTheme.typography.bodyLarge)
                                if (p.secondary.isNotEmpty()) Text(p.secondary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        searchNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("census-search-note")) }
                        }
                        if (picked != null) StatusChip("Pin from address", Look.Tone.GOOD, textTag = "census-pin-from-address")
                    }
                    FieldTextField(address, { address = it }, label = { Text("Address") }, modifier = Modifier.fillMaxWidth().testTag("census-address"))
                    (if (mode == "places") picked?.components else reverse?.components)?.line()?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("census-address-line"))
                    }
                    FieldTextField(landmark, { landmark = it.take(200) }, label = { Text("Landmark (optional)") }, placeholder = { Text("e.g. beside the chapel") },
                        singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-landmark"))
                }
            }
            SectionCard("Storefront photo") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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
        ActionBar { PrimaryBottomButton("Save store", ::save, Modifier.fillMaxWidth().testTag("census-save"), !busy && config != null && !camera) }
    }
    if (pending != null && duplicates.isNotEmpty()) ModalBottomSheet(onDismissRequest = { pending = null; duplicates = emptyList() }) {
        Column(Modifier.fillMaxWidth().bottomSafe().padding(start = 16.dp, end = 16.dp, bottom = 24.dp).testTag("census-duplicates"), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("This might already be in the list", style = MaterialTheme.typography.titleMedium)
            duplicates.take(5).forEach { d ->
                Column(Modifier.fillMaxWidth().testTag("census-duplicate")) {
                    Text(d.name, style = MaterialTheme.typography.bodyLarge)
                    d.address?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Text(listOfNotNull(DuplicateRules.distanceText(d.distanceMeters), DuplicateRules.reasonText(d.reasons).ifEmpty { null },
                        "Waiting for review".takeIf { d.kind == "capture" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                }
            }
            PrimaryBottomButton("It's this store", {
                val outlet = duplicates.firstOrNull { d -> d.kind == "outlet" && stores.any { it.outletId == d.id } }
                reset(); message = "Not saved. That store is already in the list."
                outlet?.let { o -> onOpenStore?.invoke(o.id) }
            }, Modifier.fillMaxWidth().testTag("census-dup-same"))
            SecondaryButton("It's a different store", {
                val ids = duplicates.map { it.id }; pending?.let { queue(build(ids)) }
                pending = null; duplicates = emptyList()
            }, Modifier.fillMaxWidth().testTag("census-dup-different"))
        }
    }
}
private const val OFFLINE_SEARCH = "Address search needs internet. Use my location instead."
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
