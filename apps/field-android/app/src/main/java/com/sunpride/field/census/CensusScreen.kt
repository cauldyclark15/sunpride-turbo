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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.layout.ContentScale
import com.sunpride.field.ui.ActionBar
import com.sunpride.field.ui.bottomSafe
import com.sunpride.field.ui.SafeBottomSheet
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
 * SP-0163: two location choices (Use my location / Search address), landmark, duplicate warning, optional batch.
 * SP-0170: "Add customer" captures the agent's part of the client's customer sheet (CustomerCapture) in the
 * sheet's section/field order and labels; "Edit customer" keeps the change-request form. */
@Composable
fun CensusScreen(backend: FieldBackend?, location: VisitLocation, onBack: () -> Unit, modifier: Modifier = Modifier,
    stores: List<CustomerRecord> = emptyList(), onOpenStore: ((String) -> Unit)? = null, initialName: String = "",
    editing: CustomerRecord? = null, onChangeSaved: (() -> Unit)? = null, onQueued: (() -> Unit)? = null,
    draftHolder: CustomerDraftHolder = remember { CustomerDraftHolder() }) =
    CensusScreenForTest(backend, location, onBack, modifier, stores, onOpenStore, photoForTest = null, initialName = initialName,
        editing = editing, onChangeSaved = onChangeSaved, onQueued = onQueued, draftHolder = draftHolder)

/** Tests only: [photoForTest] starts with a storefront photo (emulators have no working camera). Release code
 * calls [CensusScreen], which always passes null; lint's VisibleForTests check blocks other production callers. */
@androidx.annotation.VisibleForTesting(otherwise = androidx.annotation.VisibleForTesting.PRIVATE)
@OptIn(ExperimentalMaterial3Api::class, androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
internal fun CensusScreenForTest(backend: FieldBackend?, location: VisitLocation, onBack: () -> Unit, modifier: Modifier = Modifier,
    stores: List<CustomerRecord> = emptyList(), onOpenStore: ((String) -> Unit)? = null, photoForTest: ByteArray? = null,
    initialName: String = "", editing: CustomerRecord? = null, onChangeSaved: (() -> Unit)? = null,
    /** FLD-075: a saved customer is waiting work; the app re-reads its outbox status so the pill and Sync count it. */
    onQueued: (() -> Unit)? = null,
    /** SP-0196: the open Add customer form lives here (above the screen), so rebuilding the screen never loses it. */
    draftHolder: CustomerDraftHolder = remember { CustomerDraftHolder() }) {
    // Edit store sends a change request for this store (never a new store); the office approves it first.
    val edit = editing != null && com.sunpride.field.ui.STORE_EDIT_ENABLED
    val current = remember(editing) { editing?.let { CensusRules.Current(it.name, (it.address ?: it.account?.address).orEmpty(),
        it.contactName.orEmpty(), it.contactPhone.orEmpty()) } }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val focus = androidx.compose.ui.platform.LocalFocusManager.current
    val places = remember(backend) { runCatching { backend?.censusPlaces() }.getOrNull() }
    var config by remember { mutableStateOf<JSONObject?>(null) }
    var history by remember { mutableStateOf<List<CensusRules.Saved>>(emptyList()) }
    var message by remember { mutableStateOf("Loading customer setup…") }
    var busy by remember { mutableStateOf(false) }
    var savingDraft by remember { mutableStateOf(false) }
    // Edit store: the same form, filled from the store; the office checks the changes before they replace the record.
    // E2E-010: keyed by the store, so the form fills from the customer even when the record arrives after the
    // first frame (it otherwise kept the empty first values: name, owner and phone had to be retyped).
    val editKey = editing?.outletId
    val keep = draftHolder
    val draftEpoch = remember(backend) { backend?.authorizationEpoch }
    val draftSession = remember(keep) { keep.session }
    // SP-0196: a rebuilt screen starts from the form kept above it, never from an older phone copy.
    val held = if (edit) null else keep.draft
    // QA retest: an explicit per-store key, so a value saved earlier on this screen (for example an empty
    // Add customer form) is never restored into Edit customer; the agent must not retype the name.
    val saveKey = "census-${editKey ?: "new"}"
    var name by rememberSaveable(editKey, key = "$saveKey-name") { mutableStateOf((editing?.name ?: initialName).take(80)) }
    var address by rememberSaveable(editKey, key = "$saveKey-address") { mutableStateOf(editing?.let { it.address ?: it.account?.address }.orEmpty()) }
    var owner by rememberSaveable(editKey, key = "$saveKey-owner") { mutableStateOf(editing?.contactName.orEmpty()) }
    var phone by rememberSaveable(editKey, key = "$saveKey-phone") { mutableStateOf(editing?.contactPhone.orEmpty()) }
    LaunchedEffect(editKey) {
        val start = current ?: return@LaunchedEffect
        val filled = CensusRules.prefill(start, CensusRules.Current(name, address, owner, phone))
        name = filled.name.take(80); address = filled.address; owner = filled.ownerName; phone = filled.ownerPhone
    }
    var batch by rememberSaveable { mutableStateOf("") }; var channel by rememberSaveable { mutableStateOf("") }
    var subchannel by rememberSaveable { mutableStateOf("") }; var estimatedClass by rememberSaveable { mutableStateOf("D") }
    var landmark by rememberSaveable { mutableStateOf("") }
    var mode by rememberSaveable { mutableStateOf(if (held?.fix != null) "gps" else "") } // "", "gps", "places"
    var fix by remember { mutableStateOf<JSONObject?>(held?.fix) }; var jpeg by remember { mutableStateOf(held?.photo ?: photoForTest) }
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
    // SP-0170 Add customer: the client's fields; reference lists from the census setup, geography kept on the phone.
    val setup = remember(config) { CustomerCapture.setup(config) }
    var form by remember { mutableStateOf(held?.form?.let { if (it.customerName.isBlank()) it.copy(customerName = initialName.take(200)) else it }
        ?: CustomerCapture.Form(customerName = initialName.take(200))) }
    // SP-0220: Edit customer edits the same structured address as Add customer, starting from the saved parts.
    LaunchedEffect(editKey) { if (edit) form = CensusRules.formFromParts(editing!!.addressParts, form) }
    var geography by remember { mutableStateOf<CustomerCapture.Geography?>(null) }
    var geoNote by remember { mutableStateOf<String?>(null) }
    var formErrors by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    // SP-0176: the unsaved form is kept on the phone (Back, app restart) until saved or discarded.
    var draftLoaded by remember { mutableStateOf(!edit && keep.loaded) }
    var draftRestored by remember { mutableStateOf(held != null && !held.isEmpty()) }
    var savedDrafts by remember { mutableStateOf(keep.customers.saved) }
    var showDrafts by remember { mutableStateOf(held == null && initialName.isBlank() && keep.customers.saved.isNotEmpty()) }
    var savedNotice by keep::savedNotice
    val keyRequesters = remember { mutableMapOf<String, BringIntoViewRequester>() }
    fun requester(key: String) = keyRequesters.getOrPut(key) { BringIntoViewRequester() }
    // Live test 2026-11-09: Save must never look like it does nothing.
    var attempted by remember { mutableStateOf(false) }
    var saveNote by remember { mutableStateOf<String?>(null) }
    var staleRetry by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var moved by remember { mutableStateOf<Moved?>(null) }
    val requesters = remember { CensusRules.Field.entries.associateWith { BringIntoViewRequester() } }
    var camera by remember { mutableStateOf(false) }; var capture by remember { mutableStateOf<ImageCapture?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { camera = it; if (!it) message = "Camera access is needed for the storefront photo." }
    val locationPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        message = "Tap Use my location again after allowing precise location."
    }
    LaunchedEffect(backend) {
        try {
            // Load phone drafts independently of setup downloads: saving a draft never needs a connection.
            // The phone copy only matters when nothing is kept above the screen (the app was closed since).
            if (!edit && backend != null && !draftLoaded && !keep.loaded) {
                val json = withContext(Dispatchers.IO) { backend.customerDraft() }
                check(keep.session == draftSession && backend.authorizationEpoch == draftEpoch)
                keep.restore(json)
                savedDrafts = keep.customers.saved
                showDrafts = keep.customers.active == null && initialName.isBlank() && savedDrafts.isNotEmpty()
                val kept = keep.draft
                if (kept != null && (!kept.isEmpty() || keep.customers.activeId != null)) {
                    form = kept.form.let { if (it.customerName.isBlank()) it.copy(customerName = initialName.take(200)) else it }
                    fix = kept.fix; jpeg = kept.photo ?: jpeg; if (kept.fix != null) mode = "gps"; draftRestored = true
                }
            }
            draftLoaded = true
            config = runCatching { withContext(Dispatchers.IO) { backend?.censusConfig() } }.getOrNull()
            history = runCatching { withContext(Dispatchers.IO) { backend?.censusSaved().orEmpty() } }.getOrDefault(emptyList())
            message = if (config == null) "Connect once to download the customer setup. You can still save drafts."
                else if (!edit && CustomerCapture.setup(config) == null) "Connect once to download the customer lists. You can still save drafts."
                else if (draftRestored) DRAFT_KEPT
                else "Saved customers stay encrypted on this phone until the next sync."
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            message = if (!edit && !keep.loaded) "Could not open your customer drafts. Go back and try again; your saved drafts have not been changed."
                else "Customer setup is unavailable. Connect and refresh your signed-in account."
        }
    }
    // SP-0176: keep the draft on every change (debounced), and once more when the screen closes.
    val latestDraft by rememberUpdatedState(CustomerCapture.Draft(form, fix, jpeg))
    val draftAllowed by rememberUpdatedState(draftLoaded && !edit && savedNotice == null && !savingDraft && !busy && !showDrafts && keep.session == draftSession)
    // SP-0196: every change is kept above the screen at once; the phone copy follows (numbered, newest wins).
    SideEffect { if (draftAllowed) keep.keep(CustomerCapture.Draft(form, fix, jpeg)) }
    fun persistDraft(json: String?, ticket: Long) {
        val b = backend ?: error("Customer draft storage unavailable")
        check(b.authorizationEpoch == draftEpoch) { "Session changed" }
        check(keep.persist(ticket) {
            check(keep.session == draftSession && b.authorizationEpoch == draftEpoch) { "Session changed" }
            b.saveCustomerDraft(json)
        }) { "A newer customer draft was already saved." }
    }
    LaunchedEffect(form, fix, jpeg, draftLoaded, savingDraft, busy, showDrafts) {
        if (!draftAllowed || backend == null) return@LaunchedEffect
        delay(400)
        val json = keep.customers.keep(latestDraft).json(); val ticket = keep.ticket()
        try { withContext(Dispatchers.IO) { persistDraft(json, ticket) } }
        catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            message = "Could not keep your latest changes. Tap Save as draft to try again."
        }
    }
    DisposableEffect(backend) {
        onDispose {
            if (draftAllowed && !busy && !savingDraft && !showDrafts && savedNotice == null && backend != null) { val d = latestDraft; keep.keep(d)
                val json = keep.customers.json(); val ticket = keep.ticket()
                Thread { runCatching { persistDraft(json, ticket) } }.start() }
        }
    }
    // Sales Organization defaults from the agent's assignment once the setup is known.
    LaunchedEffect(setup) { if (setup != null && form.salesOrgCode.isEmpty()) form = CustomerCapture.start(setup, form.customerName).let { form.copy(salesOrgCode = it.salesOrgCode) } }
    LaunchedEffect(backend, setup) {
        if (backend == null) return@LaunchedEffect
        val provinces = (setup?.provinceCodes.orEmpty() + listOfNotNull(editing?.addressParts?.get("provinceCode"))).distinct()
        geography = runCatching { withContext(Dispatchers.IO) { backend.customerGeography(provinces) } }.getOrNull()
        if (geography == null) geoNote = "Connect once to download the Region, Province and Municipality lists."
    }
    // A province whose barangays are not on the phone yet: fetch them now (kept for offline use).
    LaunchedEffect(form.provinceCode) {
        val g = geography ?: return@LaunchedEffect
        val province = form.provinceCode.takeIf { it.isNotEmpty() && !g.hasBarangays(it) } ?: return@LaunchedEffect
        val got = runCatching { withContext(Dispatchers.IO) { backend?.customerGeography(listOf(province)) } }.getOrNull()
        if (got != null && got.hasBarangays(province)) { geography = got; geoNote = null }
        else geoNote = "The Barangay list for this province is not on the phone yet. Connect to download it, or leave Barangay for the office."
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
    fun missingNow() = if (edit) CensusRules.missingForChange(name, owner, phone, mode, fix != null, picked != null, form.street1)
        else CensusRules.missing(name, owner, phone, channel, subchannel, mode, fix != null, picked != null, address, jpeg != null)
    val marked = if (attempted && edit) missingNow().toSet() else emptySet()
    fun customerMissing() = CustomerCapture.missing(form, setup, geography, fix != null, jpeg != null)
    // Missing (after a Save attempt) or invalid fields, by contract key, with the message to show under each.
    val customerMarks: Map<String, String> = if (edit) emptyMap() else
        (if (attempted) customerMissing().associate { it.key to it.message } else emptyMap()) + formErrors
    fun useMyLocation() {
        if (location.requiresPermission && ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            if (edit || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                locationPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)); return
            }
        }
        // E2E-010: on Edit the searched pin and the agent's own fix are kept side by side (both are sent).
        if (!edit || picked == null) { mode = "gps"; picked = null }
        predictions = emptyList()
        scope.launch {
            busy = true; locationNote = "Getting your location…"
            try {
                val got = if (edit) location.fixWithinAccuracy(50.0) else try { location.customerFix() }
                    catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { null }
                if (!edit) {
                    fix = CustomerLocation.best(fix, got, System.currentTimeMillis())
                    fix?.let { lastFix = it.getDouble("latitude") to it.getDouble("longitude") }
                    locationNote = if (fix == null) CustomerLocation.UNCONFIRMED else "Best available location kept. You can save this customer."
                    return@launch
                }
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
                if (!edit) return@launch // Add customer: the address comes from the location pickers.
                if (mode == "places") return@launch // the searched address stays the address
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
                        address = r.value.formattedAddress; autoAddress = address; if (!edit) fix = null
                        session = CensusPlaces.session() // the session ends with the details call
                    }
                    CensusPlaces.Result.Offline -> searchNote = OFFLINE_SEARCH
                    CensusPlaces.Result.Unavailable -> searchNote = "Could not open that address. Try again or use my location."
                }
            } finally { busy = false }
        }
    }
    fun reset(keepLocation: Boolean = true) {
        name = ""; address = ""; owner = ""; phone = ""; fix = null; jpeg = null; landmark = ""; mode = ""; picked = null
        reverse = null; autoAddress = null; query = ""; predictions = emptyList(); locationNote = null; searchNote = null
        duplicates = emptyList(); pending = null; attempted = false; saveNote = null; staleRetry = false; moved = null
        form = if (keepLocation) CustomerCapture.start(setup).copy(regionCode = form.regionCode, provinceCode = form.provinceCode,
            municipalityCode = form.municipalityCode) else CustomerCapture.start(setup)
        formErrors = emptyMap()
    }
    fun storeDrafts(next: CustomerDrafts, notice: String, list: Boolean = false, after: () -> Unit = {}) {
        if (busy || !draftLoaded || backend == null || keep.session != draftSession) return
        val json = next.json(); val ticket = keep.ticket()
        busy = true; savingDraft = true
        scope.launch {
            try {
                // Finish a requested phone write even if Back closes the screen during IO.
                withContext(kotlinx.coroutines.NonCancellable) {
                    withContext(Dispatchers.IO) { persistDraft(json, ticket) }
                    check(keep.session == draftSession && backend.authorizationEpoch == draftEpoch)
                    keep.replace(next); savedDrafts = next.saved
                    reset(keepLocation = false); camera = false; draftRestored = false; showDrafts = list
                    message = notice
                    after()
                }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                saveNote = "Could not save the draft. Your entries are still here. Try again."
            } finally { busy = false; savingDraft = false }
        }
    }
    fun saveAsDraft() {
        focus.clearFocus()
        storeDrafts(keep.customers.save(CustomerCapture.Draft(form, fix, jpeg)), DRAFT_SAVED, list = true)
    }
    fun browseDrafts() {
        focus.clearFocus()
        val d = CustomerCapture.Draft(form, fix, jpeg)
        val next = if (!d.isEmpty() || keep.customers.activeId != null) keep.customers.save(d)
            else keep.customers.copy(active = null)
        storeDrafts(next, "Open a draft to continue, or add another customer.", list = true)
    }
    fun discardDraft(after: () -> Unit = {}) {
        storeDrafts(keep.customers.clear(), "Started again. This draft was discarded; your other drafts were kept.", after = after)
    }
    fun openDraft(id: String) {
        if (busy) return
        val next = keep.customers.open(id)
        val d = checkNotNull(next.active)
        reset(keepLocation = false); keep.replace(next)
        form = d.form; fix = d.fix; jpeg = d.photo; mode = if (d.fix == null) "" else "gps"
        camera = false; showDrafts = false
        draftRestored = true; message = DRAFT_KEPT
    }
    fun queue(p: JSONObject) {
        val backendNow = backend ?: return
        val completed = keep.customers.clear(); val ticket = keep.ticket()
        busy = true // synchronously: a second tap can never reach the cleared form
        scope.launch {
            try {
                CensusRules.validate(p)
                withContext(kotlinx.coroutines.NonCancellable) {
                    withContext(Dispatchers.IO) {
                        check(keep.persist(ticket) {
                            check(keep.session == draftSession && backendNow.authorizationEpoch == draftEpoch)
                            if (CensusRules.isChange(p)) backendNow.queueCensus(p)
                            else backendNow.queueCustomer(p, completed.json())
                        })
                    }
                    if (!CensusRules.isChange(p)) {
                        check(keep.session == draftSession && backendNow.authorizationEpoch == draftEpoch)
                        keep.replace(completed); savedDrafts = completed.saved
                        reset(); draftRestored = false
                        savedNotice = if (isOnline(context)) SAVED_ONLINE else SAVED_OFFLINE
                    }
                }
                onQueued?.invoke()
                history = runCatching { withContext(Dispatchers.IO) { backendNow.censusSaved() } }.getOrDefault(history)
                if (CensusRules.isChange(p)) {
                    message = "Change saved on phone. The office checks it first."
                    onChangeSaved?.invoke()
                    return@launch
                }
                message = "Customer saved on this phone. The CDM reviews and verifies it after sync."

            } catch (e: Exception) {
                message = if (e is IllegalArgumentException) e.message ?: "Complete every field." else "Could not save. Check your offline recording access and retry."
                saveNote = message
            }
            finally { busy = false }
        }
    }
    fun build(acknowledged: List<String>): JSONObject {
        val place = picked?.takeIf { mode == "places" }?.let {
            CensusRules.Place(it.placeId ?: "", it.latitude ?: Double.NaN, it.longitude ?: Double.NaN, it.formattedAddress, it.components.json())
        }
        if (!edit) return CustomerCapture.payload(CensusRules.captureId(), form, geography, System.currentTimeMillis(),
            fix, jpeg?.let { Base64.getEncoder().encodeToString(it) } ?: "", acknowledged)
        if (edit) return CensusRules.changePayload(CensusRules.captureId(), editing!!.outletId, name,
            CensusRules.addressLine(form, geography).ifEmpty { form.street1 }, owner, phone,
            System.currentTimeMillis(), if (mode == "gps" || (mode == "places" && place != null)) fix?.takeIf { CensusRules.fixUsable(it) } else null,
            place, landmark, jpeg?.let { Base64.getEncoder().encodeToString(it) }, CensusRules.addressPartsJson(form))
        return CensusRules.payload(CensusRules.captureId(), CensusRules.chosenBatch(showBatch, batch), name, address, owner, phone, channel, subchannel,
            estimatedClass, System.currentTimeMillis(), if (mode == "gps") fix else null, place, landmark,
            reverse?.takeIf { mode == "gps" }?.let { it.formattedAddress to it.components.json() }, acknowledged,
            jpeg?.let { Base64.getEncoder().encodeToString(it) } ?: "")
    }
    fun save() {
        backend ?: return
        if (busy || (!edit && !draftLoaded)) return // never overwrite drafts before they have loaded
        saveNote = null; staleRetry = false
        if (!edit) {
            val s = setup ?: run { saveNote = "Connect once to download the customer lists."; return }
            val miss = customerMissing()
            val errors = CustomerCapture.draftErrors(form, s, geography, fix?.optDouble("latitude"), fix?.optDouble("longitude"))
                .associate { it.field to it.message }
            formErrors = errors
            if (miss.isNotEmpty() || errors.isNotEmpty()) {
                attempted = true
                val first = (miss.map { it.key } + errors.keys).minByOrNull { MARK_ORDER.indexOf(it).let { i -> if (i < 0) 99 else i } }
                if (miss.isEmpty()) saveNote = errors.values.first()
                scope.launch { delay(50); first?.let { requester(it).bringIntoView() } }
                return
            }
            mode = "gps"
        } else {
        val miss = missingNow()
        if (miss.isNotEmpty()) {
            // Never silent: mark every missing field and scroll to the first one.
            attempted = true
            scope.launch { delay(50); requesters[miss.first()]?.bringIntoView() }
            return
        }
        }
        busy = true // synchronously, before the coroutine is dispatched
        scope.launch {
            try {
                // Use my location goes stale after two minutes: get a fresh fix instead of refusing. Address search is not a GPS fix.
                if (edit && mode == "gps" && CensusRules.fixIsStale(fix, System.currentTimeMillis())) {
                    refreshing = true
                    val got = try { location.fixWithinAccuracy(50.0) } catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { null }
                        finally { refreshing = false }
                    if (got == null || !CensusRules.fixUsable(got)) { saveNote = STALE_FIX; staleRetry = true; return@launch }
                    val old = fix
                    fix = got; lastFix = got.getDouble("latitude") to got.getDouble("longitude")
                    if (CensusRules.movedTooFar(old, got)) {
                        val r = places?.takeIf { edit }?.let { api -> withTimeoutOrNull(5_000) { withContext(Dispatchers.IO) { api.reverse(got.getDouble("latitude"), got.getDouble("longitude")) } } }
                        moved = Moved(DuplicateRules.distanceMeters(old?.optDouble("latitude"), old?.optDouble("longitude"),
                            got.getDouble("latitude"), got.getDouble("longitude")) ?: 0.0, (r as? CensusPlaces.Result.Ok)?.value)
                        saveNote = "Your location changed. Check the address, then save."
                        return@launch
                    }
                }
                if (edit && mode == "gps" && fix == null) throw IllegalArgumentException("Tap Use my location and wait for a good signal.")
                // E2E-010: a searched pin on Edit is sent with the agent's own fix, fetched now if none is fresh, so the
                // office sees how far the new pin is from where the agent stood.
                if (edit && mode == "places" && picked != null && (fix == null || CensusRules.fixIsStale(fix, System.currentTimeMillis()))) {
                    val got = try { withTimeoutOrNull(10_000) { location.fixWithinAccuracy(50.0) } }
                        catch (e: kotlinx.coroutines.CancellationException) { throw e } catch (_: Exception) { null }
                    fix = got?.takeIf { CensusRules.fixUsable(it) }
                }
                val draft = build(emptyList()); CensusRules.validate(draft)
                if (edit) {
                    // A change is for this store: no duplicate check, nothing to send when nothing changed.
                    if (!CensusRules.changed(current!!, name, current.address, owner, phone, landmark, draft.has("location"), jpeg != null) &&
                        !CensusRules.addressPartsChanged(editing!!.addressParts, form)) {
                        saveNote = "Nothing was changed."; return@launch
                    }
                    busy = false; queue(draft); return@launch
                }
                val loc = draft.optJSONObject("location")
                val dupName = if (edit) name else CustomerCapture.storeName(form); val dupPhone = if (edit) phone else form.mobileNo
                val query = DuplicateRules.Store("", dupName, dupPhone, loc?.getDouble("latitude"), loc?.getDouble("longitude"), draft.optString("placeId").ifEmpty { null })
                val local = DuplicateRules.find(query, stores.map { DuplicateRules.Store(it.outletId, it.name, null, it.latitude, it.longitude, address = it.address) })
                val server = places?.let { api -> withTimeoutOrNull(5_000) { withContext(Dispatchers.IO) {
                    api.duplicateCheck(dupName.trim(), dupPhone.trim(), query.latitude, query.longitude, query.placeId) } } }
                val found = DuplicateRules.merge(local, (server as? CensusPlaces.Result.Ok)?.value.orEmpty())
                busy = false
                if (found.isEmpty()) queue(draft) else { duplicates = found; pending = draft }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                message = if (e is IllegalArgumentException) e.message ?: "Complete every field." else "Could not save. Check your offline recording access and retry."
                saveNote = message
            }
            finally { busy = false }
        }
    }
    Column(modifier.fillMaxSize().imePadding()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (edit) Text("The office checks your changes first.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("census-edit-note"))
            NoticeCard(message, tone = if (config == null) Look.Tone.WARN else Look.Tone.NEUTRAL,
                glyph = if (config == null) GlyphKind.INFO else GlyphKind.LOCK, textTag = "census-message")
            if (!edit && draftLoaded) {
                StatusChip("Draft · not sent for approval", Look.Tone.NEUTRAL, textTag = "customer-draft-state")
                if (showDrafts) {
                    SectionCard("Drafts") {
                        Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Saved on this phone. Open a draft to finish it, then tap Submit for approval.", style = MaterialTheme.typography.bodySmall)
                            if (savedDrafts.isEmpty()) Text("No saved drafts yet.", modifier = Modifier.testTag("customer-drafts-empty"))
                            savedDrafts.forEach { entry ->
                                TonalButton(entry.name, { openDraft(entry.id) },
                                    Modifier.fillMaxWidth().testTag("customer-draft-${entry.id}"), !busy)
                            }
                        }
                    }
                } else SecondaryButton("Drafts (${savedDrafts.size})", ::browseDrafts,
                    Modifier.fillMaxWidth().testTag("customer-drafts"), !busy)
            }
            if (edit || !showDrafts) {
            if (!edit) CustomerSections(setup, geography, form, { formErrors = formErrors - changedKeys(form, it); form = it }, customerMarks, ::requester,
                geoNote, fix, busy, ::useMyLocation, locationNote)
            if (edit) {
            SectionCard("Customer") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (showBatch && !edit) CensusPicker("Gathering batch (optional)", choices("batches"), batch, { batch = it }, "census-batch",
                        empty = "Ongoing gathering (default)")
                    Marked(CensusRules.Field.NAME, marked, requesters) { FieldTextField(name, { name = it }, label = { Text("Customer name") }, singleLine = true, isError = CensusRules.Field.NAME in marked, modifier = Modifier.fillMaxWidth().testTag("census-name")) }
                }
            }
            SectionCard("Owner") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Marked(CensusRules.Field.OWNER, marked, requesters) { FieldTextField(owner, { owner = it }, label = { Text("Owner contact name") }, singleLine = true, isError = CensusRules.Field.OWNER in marked, modifier = Modifier.fillMaxWidth().testTag("census-owner")) }
                    Marked(CensusRules.Field.PHONE, marked, requesters) { FieldTextField(phone, { phone = it }, label = { Text("Owner phone") }, singleLine = true, isError = CensusRules.Field.PHONE in marked, modifier = Modifier.fillMaxWidth().testTag("census-phone"),
                        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Phone)) }
                }
            }
            if (!edit) SectionCard("Channel") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Marked(CensusRules.Field.CHANNEL, marked, requesters) { CensusPicker("Channel", choices("channels"), channel, { channel = it; subchannel = "" }, "census-channel") }
                    Marked(CensusRules.Field.SUBCHANNEL, marked, requesters) { CensusPicker("Sub-channel", choices("subchannels"), subchannel, { subchannel = it }, "census-subchannel",
                        empty = if (channel.isEmpty()) "Choose a channel first" else "Choose…") }
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
                            else TonalButton("Search address", { mode = "places"; if (!edit) fix = null; reverse = null; locationNote = null; session = CensusPlaces.session() },
                                Modifier.weight(1f).testTag("census-search-mode"), !busy)
                        }
                    }
                    if (edit && mode == "") Text("Keep the customer's pin, or set a new one.", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("census-edit-location"))
                    Marked(CensusRules.Field.LOCATION, marked, requesters) { }
                    if (mode == "gps" || (edit && mode == "places")) fix?.let { StatusChip("Your location ±${it.getDouble("accuracyMeters").toInt()} m", Look.Tone.GOOD, textTag = "census-accuracy") }
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
                    // SP-0220: the same address fields as Add customer (Street 1 required); the server builds the address.
                    current?.address?.takeIf { it.isNotBlank() }?.let { Text("Current address: $it", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("census-current-address")) }
                    Marked(CensusRules.Field.ADDRESS, emptySet(), requesters) {
                        AddressFields(geography, form, { form = it },
                            if (CensusRules.Field.ADDRESS in marked) mapOf("street1" to "Street 1 is required.") else emptyMap(), ::requester, geoNote)
                    }
                    (if (mode == "places") picked?.components else reverse?.components)?.line()?.takeIf { it.isNotEmpty() }?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("census-address-line"))
                    }
                    FieldTextField(landmark, { landmark = it.take(200) }, label = { Text("Landmark (optional)") }, placeholder = { Text("e.g. beside the chapel") },
                        singleLine = true, modifier = Modifier.fillMaxWidth().testTag("census-landmark"))
                }
            }
            }
            if (!edit) EnrollmentFieldsSection(setup?.enrollmentFields.orEmpty(), form, { formErrors = formErrors - changedKeys(form,it); form = it }, customerMarks, !busy, { busy = it })
            SectionCard("Storefront photo") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    if (camera) {
                        CameraPreview({ capture = it }, { message = "Camera unavailable." }, Modifier.fillMaxWidth().height(260.dp).clip(RoundedCornerShape(20.dp)))
                        PrimaryBottomButton("Take storefront photo", {
                            val still = capture ?: return@PrimaryBottomButton
                            val output = ByteArrayOutputStream(); busy = true
                            still.takePicture(ImageCapture.OutputFileOptions.Builder(output).build(), ContextCompat.getMainExecutor(context), object : ImageCapture.OnImageSavedCallback {
                                override fun onImageSaved(result: ImageCapture.OutputFileResults) {
                                    scope.launch { try { jpeg = withContext(Dispatchers.Default) { boundedJpeg(output.toByteArray()) }; camera = false; message = "Storefront photo saved for this customer." } catch (_: Exception) { message = "Could not prepare the photo. Try again." } finally { busy = false } }
                                }
                                override fun onError(exception: ImageCaptureException) { busy = false; message = "Could not take the photo. Try again." }
                            })
                        }, Modifier.fillMaxWidth().testTag("census-shutter"), !busy)
                    } else TonalButton(if (jpeg == null) "Open storefront camera" else "Retake storefront photo", {
                        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) camera = true
                        else cameraPermission.launch(Manifest.permission.CAMERA)
                    }, Modifier.fillMaxWidth().testTag("census-camera"), !busy, glyph = GlyphKind.CAMERA)
                    Marked(CensusRules.Field.PHOTO, marked, requesters) { }
                    if (!edit) KeyMark("photo", customerMarks, ::requester)
                    jpeg?.let { bytes -> BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.let { Image(it.asImageBitmap(), "Captured storefront", Modifier.fillMaxWidth().height(180.dp).clip(RoundedCornerShape(16.dp)), contentScale = ContentScale.Crop) } }
                }
            }
            if (history.isNotEmpty()) SectionCard("Saved customers") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    history.takeLast(20).reversed().forEach { saved ->
                        Column(Modifier.fillMaxWidth().testTag("census-saved")) {
                            Text("${saved.name} · ${CensusRules.savedLabel(saved)}", style = MaterialTheme.typography.bodyMedium)
                            saved.owner?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    }
                }
            }
            }
        }
        ActionBar {
            if (showDrafts && !edit) PrimaryBottomButton("Add another customer", {
                reset(keepLocation = false); showDrafts = false
            }, Modifier.fillMaxWidth().testTag("customer-drafts-new"), !busy)
            else {
            if (!edit && draftLoaded && (!CustomerCapture.Draft(form, fix, jpeg).isEmpty() || keep.customers.activeId != null))
                TextButton({ discardDraft() },
                    Modifier.fillMaxWidth().testTag("census-discard"), enabled = !busy) { Text("Discard and start again") }
            val note = saveNote ?: if (marked.isNotEmpty()) CensusRules.missingSummary(marked.size)
                else if (customerMarks.isNotEmpty()) CensusRules.missingSummary(customerMarks.size) else null
            note?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("census-save-note")) }
            if (staleRetry) TonalButton("Try again", ::save, Modifier.fillMaxWidth().testTag("census-retry"), !busy)
            if (!edit) TonalButton("Save as draft", ::saveAsDraft, Modifier.fillMaxWidth().testTag("customer-save-draft"),
                !busy && draftLoaded && backend != null && !camera)
            PrimaryBottomButton(if (refreshing) "Checking your location…" else if (edit) "Save changes" else "Submit for approval", ::save,
                Modifier.fillMaxWidth().testTag("census-save"), !busy && (edit || (draftLoaded && setup != null)) && !camera)
            }
        }
    }
    savedNotice?.let { text ->
        AlertDialog(onDismissRequest = { savedNotice = null; onBack() },
            confirmButton = { TextButton({ savedNotice = null; onBack() }, Modifier.testTag("census-saved-ok")) { Text("OK") } },
            title = { Text("Customer saved") },
            text = { Text(text, modifier = Modifier.testTag("census-saved-notice")) }, modifier = Modifier.testTag("census-saved-dialog"))
    }
    moved?.let { m -> SafeBottomSheet(onDismissRequest = { moved = null }, Modifier.testTag("census-moved")) {
            Text("Your location changed", style = MaterialTheme.typography.titleMedium)
            Text("You are ${m.meters.toInt()} m from where you first set the location.", style = MaterialTheme.typography.bodyMedium)
            if (m.address != null) {
                Text("New address", style = MaterialTheme.typography.labelMedium)
                Text(m.address.formattedAddress, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("census-moved-address"))
                PrimaryBottomButton("Use the new address and save", {
                    if (!busy) { address = m.address.formattedAddress; autoAddress = address; reverse = m.address; moved = null; save() }
                }, Modifier.fillMaxWidth().testTag("census-moved-new"), !busy)
            } else Text("No address found for the new spot. Check the address before you save.", style = MaterialTheme.typography.bodyMedium)
            SecondaryButton("Keep my address and save", { if (!busy) { moved = null; save() } }, Modifier.fillMaxWidth().testTag("census-moved-keep"), !busy)
    } }
    if (pending != null && duplicates.isNotEmpty()) SafeBottomSheet(onDismissRequest = { pending = null; duplicates = emptyList() }, Modifier.testTag("census-duplicates")) {
            Text("This might already be in the list", style = MaterialTheme.typography.titleMedium)
            duplicates.take(5).forEach { d ->
                Column(Modifier.fillMaxWidth().testTag("census-duplicate")) {
                    Text(d.name, style = MaterialTheme.typography.bodyLarge)
                    d.address?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    Text(listOfNotNull(DuplicateRules.distanceText(d.distanceMeters), DuplicateRules.reasonText(d.reasons).ifEmpty { null },
                        "Waiting for review".takeIf { d.kind == "capture" }).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
                }
            }
            PrimaryBottomButton("It's this customer", {
                val outlet = duplicates.firstOrNull { d -> d.kind == "outlet" && stores.any { it.outletId == d.id } }
                discardDraft { outlet?.let { o -> onOpenStore?.invoke(o.id) } }
            }, Modifier.fillMaxWidth().testTag("census-dup-same"))
            SecondaryButton("It's a different customer", {
                val ids = duplicates.map { it.id }; pending?.let { queue(build(ids)) }
                pending = null; duplicates = emptyList()
            }, Modifier.fillMaxWidth().testTag("census-dup-different"))
    }
}
internal const val SAVED_ONLINE = "Customer saved. Sent to the office for approval."
internal const val SAVED_OFFLINE = "Saved. It will send when you have signal."
internal const val DRAFT_KEPT = "Your customer draft was kept. Complete it and tap Submit for approval, or save it as a draft again."
internal const val DRAFT_SAVED = "Draft saved on this phone. It has not been sent for approval. Open it from Drafts to continue later."
private fun isOnline(context: android.content.Context): Boolean = runCatching {
    val cm = context.getSystemService(android.net.ConnectivityManager::class.java)
    val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
    caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
        caps.hasCapability(android.net.NetworkCapabilities.NET_CAPABILITY_VALIDATED)
}.getOrDefault(false)
private const val STALE_FIX = "Couldn't get your location. Move to an open spot and tap Try again."
private class Moved(val meters: Double, val address: CensusPlaces.Address?)
/** A required field plus its plain-words message once Save found it missing; Save scrolls here. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun Marked(field: CensusRules.Field, marked: Set<CensusRules.Field>, requesters: Map<CensusRules.Field, BringIntoViewRequester>,
    content: @Composable () -> Unit) {
    Column(Modifier.fillMaxWidth().bringIntoViewRequester(requesters.getValue(field)), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        content()
        if (field in marked) Text(field.message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(start = 14.dp).testTag("census-missing-${field.name.lowercase()}"))
    }
}
private const val OFFLINE_SEARCH = "Address search needs internet. Use my location instead."
@Composable
internal fun CensusPicker(label: String, choices: List<Pair<String, String>>, value: String, onChange: (String) -> Unit, tag: String,
    empty: String = "Choose…") {
    var expanded by remember { mutableStateOf(false) }
    Box {
        PickerField(label, choices.firstOrNull { it.first == value }?.second, empty, { expanded = true }, Modifier.testTag(tag))
        // SP-0176: long lists (Barangay, Customer Group ~90) open a type-to-search list.
        if (choices.size > SEARCH_PICKER_MIN) {
            if (expanded) SearchPickerDialog(label, choices, { onChange(it); expanded = false }, { expanded = false }, tag)
        } else DropdownMenu(expanded, { expanded = false }) { choices.forEach { choice -> DropdownMenuItem(text = { Text(choice.second) }, onClick = { onChange(choice.first); expanded = false }) } }
    }
}
internal const val SEARCH_PICKER_MIN = 12
/** Words in any order, case and accents ignored ("sto nino" finds "Santo Niño"? no: "sto" must be in the label). */
internal fun pickerMatches(label: String, query: String): Boolean {
    fun norm(t: String) = java.text.Normalizer.normalize(t, java.text.Normalizer.Form.NFD).replace(Regex("\\p{M}+"), "").lowercase()
    val l = norm(label); return norm(query).split(Regex("\\s+")).filter { it.isNotEmpty() }.all { l.contains(it) }
}
@Composable
private fun SearchPickerDialog(label: String, choices: List<Pair<String, String>>, onPick: (String) -> Unit, onDismiss: () -> Unit, tag: String) {
    var q by remember { mutableStateOf("") }
    val shown = remember(q, choices) { choices.filter { pickerMatches(it.second, q) } }
    androidx.compose.ui.window.Dialog(onDismissRequest = onDismiss) {
        Surface(shape = RoundedCornerShape(20.dp), modifier = Modifier.fillMaxWidth().fillMaxHeight(0.85f).testTag("$tag-dialog")) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(label, style = MaterialTheme.typography.titleMedium)
                FieldTextField(q, { q = it.take(60) }, label = { Text("Type to search") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("$tag-search"))
                Text("${shown.size} of ${choices.size}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                androidx.compose.foundation.lazy.LazyColumn(Modifier.weight(1f)) {
                    items(shown.size) { i -> val c = shown[i]
                        Text(c.second, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.fillMaxWidth()
                            .clickable { onPick(c.first) }.padding(vertical = 12.dp).testTag("$tag-option"))
                    }
                }
                TextButton(onDismiss, Modifier.align(androidx.compose.ui.Alignment.End)) { Text("Cancel") }
            }
        }
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

/** Contract keys in form order, to scroll to the first marked field. */
private val MARK_ORDER = CustomerMaster.FIELDS.map {
    if (it.shipTo && it.key == "mobileNo") "shipToMobileNo" else if (it.shipTo && it.key == "email") "shipToEmail" else it.key
} + "photo"
/** Keys whose value the edit changed (their old error is cleared until the next Save). */
private fun changedKeys(old: CustomerCapture.Form, new: CustomerCapture.Form): Set<String> {
    fun values(f: CustomerCapture.Form) = f.values() + mapOf("contactPerson" to f.contactPerson,
        "shipToParty" to f.shipToParty, "shipToAddress" to f.shipToAddress, "shipToMobileNo" to f.shipToMobileNo, "shipToEmail" to f.shipToEmail)
    val a = values(old) + old.customFields.mapKeys { "customFields.${it.key}" }; val b = values(new) + new.customFields.mapKeys { "customFields.${it.key}" }
    return (a.keys + b.keys).filter { a[it] != b[it] }.toSet() +
        if (old.sameAsCustomer != new.sameAsCustomer) setOf("shipToParty", "shipToAddress", "shipToMobileNo", "shipToEmail") else emptySet()
}
/** The message under a field once Save found it missing or invalid. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun KeyMark(key: String, marks: Map<String, String>, requester: (String) -> BringIntoViewRequester) {
    Box(Modifier.fillMaxWidth().bringIntoViewRequester(requester(key))) {
        marks[key]?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error,
            modifier = Modifier.padding(start = 14.dp).testTag("customer-missing-$key")) }
    }
}
@Composable
private fun CmText(key: String, value: String, onChange: (String) -> Unit, marks: Map<String, String>,
    requester: (String) -> BringIntoViewRequester, max: Int, keyboard: androidx.compose.ui.text.input.KeyboardType =
        androidx.compose.ui.text.input.KeyboardType.Text, hint: String? = null, enabled: Boolean = true,
    normalizeOnBlur: Boolean = true, normalize: (String) -> String = { CustomerCapture.normalizeText(key, it) }) {
    var wasFocused by remember(key) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FieldTextField(value, { onChange(it.take(max)) }, label = { Text(CustomerCapture.formLabel(key)) }, singleLine = true,
            isError = key in marks, placeholder = hint?.let { h -> { Text(h) } }, enabled = enabled,
            modifier = Modifier.fillMaxWidth().testTag("customer-$key").onFocusChanged { state ->
                if (wasFocused && !state.isFocused && enabled && normalizeOnBlur) {
                    val normalized = normalize(value)
                    if (normalized != value) onChange(normalized)
                }
                wasFocused = state.isFocused
            },
            keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = keyboard))
        KeyMark(key, marks, requester)
    }
}
@Composable
private fun CmPicker(key: String, options: List<CustomerCapture.Option>, value: String, onChange: (String) -> Unit,
    marks: Map<String, String>, requester: (String) -> BringIntoViewRequester, empty: String = "Choose…") {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        CensusPicker(CustomerCapture.formLabel(key), options.map { it.code to it.label }, value, onChange, "customer-$key", empty)
        KeyMark(key, marks, requester)
    }
}
private fun geoOptions(rows: List<Pair<String, String>>) = rows.map { CustomerCapture.Option(it.first, it.second) }

/** SP-0170/SP-0220: Region to Postal Code, shared by Add customer and Edit customer. */
@Composable
private fun AddressFields(geography: CustomerCapture.Geography?, form: CustomerCapture.Form,
    onChange: (CustomerCapture.Form) -> Unit, marks: Map<String, String>, requester: (String) -> BringIntoViewRequester, geoNote: String?) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        val g = geography
        geoNote?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.testTag("customer-geo-note")) }
        CmPicker("regionCode", geoOptions(g?.regions.orEmpty().map { it.code to it.name }), form.regionCode,
            { onChange(form.withRegion(it)) }, marks, requester)
        CmPicker("provinceCode", geoOptions(g?.provincesOf(form.regionCode).orEmpty().map { it.code to it.name }), form.provinceCode,
            { onChange(form.withProvince(it)) }, marks, requester, if (form.regionCode.isEmpty()) "Choose Region first" else "Choose…")
        CmPicker("municipalityCode", geoOptions(g?.municipalitiesOf(form.provinceCode).orEmpty().map { it.code to it.name }),
            form.municipalityCode, { onChange(form.withMunicipality(it, g)) }, marks, requester,
            if (form.provinceCode.isEmpty()) "Choose Province first" else "Choose…")
        val barangays = g?.barangaysOf(form.municipalityCode)
        CmPicker("barangayCode", geoOptions(barangays.orEmpty().map { it.code to it.name }), form.barangayCode,
            { onChange(form.withBarangay(it, g)) }, marks, requester,
            when { form.municipalityCode.isEmpty() -> "Choose Municipality first"; barangays == null -> "Not on this phone yet"; else -> "Choose…" })
        CmText("houseNo", form.houseNo, { onChange(form.copy(houseNo = it)) }, marks, requester, 60)
        CmText("street1", form.street1, { onChange(form.copy(street1 = it)) }, marks, requester, 200)
        CmText("street2", form.street2, { onChange(form.copy(street2 = it)) }, marks, requester, 200)
        CmText("floor", form.floor, { onChange(form.copy(floor = it)) }, marks, requester, 60)
        CmText("roomStallNo", form.roomStallNo, { onChange(form.copy(roomStallNo = it)) }, marks, requester, 60)
        // The town list is a convenience, never the only way to enter a ZIP.
        CmText("postalCode", form.postalCode, { onChange(form.copy(postalCode = it)) }, marks, requester, 4,
            androidx.compose.ui.text.input.KeyboardType.Number, hint = "Optional · type 4 digits")
        val postal = g?.postalOptionsOf(form.municipalityCode).orEmpty()
        var postalSearch by remember { mutableStateOf(false) }
        if (postal.isNotEmpty()) TextButton(onClick = { postalSearch = true }, modifier = Modifier.testTag("customer-postalCode-list")) {
            Text("Search postal list")
        }
        if (postalSearch) SearchPickerDialog("Postal Code", postal.map { it.code to it.label },
            { onChange(form.copy(postalCode = it)); postalSearch = false }, { postalSearch = false }, "customer-postalCode")
    }
}

/** SP-0170 Add customer: the agent's fields in the client's sections, order and labels. */
@Composable
private fun CustomerSections(setup: CustomerCapture.Setup?, geography: CustomerCapture.Geography?, form: CustomerCapture.Form,
    onChange: (CustomerCapture.Form) -> Unit, marks: Map<String, String>, requester: (String) -> BringIntoViewRequester,
    geoNote: String?, fix: JSONObject?, busy: Boolean, useMyLocation: () -> Unit, locationNote: String?) {
    val pad = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 16.dp)
    val phone = androidx.compose.ui.text.input.KeyboardType.Phone
    SectionCard(CustomerMaster.GENERAL) {
        Column(pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CmText("registeredName", form.registeredName, { onChange(form.copy(registeredName = it)) }, marks, requester, 200)
            CmText("tradeName", form.tradeName, { onChange(form.copy(tradeName = it)) }, marks, requester, 200)
            CmText("customerName", CustomerCapture.customerName(form), { onChange(form.copy(customerName = it, firstName = "", middleName = "", lastName = "")) }, marks, requester, 200)
            // SP-0220: no separate Customer Address field; Street 1 and the location below are the address.
            CmText("email", form.email, { onChange(form.copy(email = it)) }, marks, requester, 200,
                androidx.compose.ui.text.input.KeyboardType.Email)
            CmText("mobileNo", form.mobileNo, { onChange(form.copy(mobileNo = it)) }, marks, requester, 20, phone, "09XXXXXXXXX")
            CmText("telNo", form.telNo, { onChange(form.copy(telNo = it)) }, marks, requester, 40, phone)
            CmText("tin", form.tin, { onChange(form.copy(tin = it)) }, marks, requester, 20, androidx.compose.ui.text.input.KeyboardType.Number,
                "Optional · ###-###-###")
            CustomerDetailFields(listOf("taxClassificationCode"), setup, form, onChange, marks, requester)
        }
    }
    SectionCard(CustomerMaster.LOCATION) {
        Column(pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CustomerDetailFields(listOf("countryCode"), setup, form, onChange, marks, requester)
            AddressFields(geography, form, onChange, marks, requester, geoNote)
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(CustomerCapture.formLabel("coordinates"), style = MaterialTheme.typography.labelMedium)
                if (fix == null) PrimaryBottomButton("Use my location", useMyLocation, Modifier.fillMaxWidth().testTag("census-gps"), !busy)
                else TonalButton("Use my location again", useMyLocation, Modifier.fillMaxWidth().testTag("census-gps"), !busy, glyph = GlyphKind.PIN)
                if (!CustomerLocation.usable(fix, System.currentTimeMillis())) Text(CustomerLocation.UNCONFIRMED,
                    style = MaterialTheme.typography.bodySmall, modifier = Modifier.testTag("customer-location-unconfirmed"))
                fix?.let { StatusChip("%.6f, %.6f · ±%d m".format(java.util.Locale.US, it.getDouble("latitude"), it.getDouble("longitude"),
                    it.getDouble("accuracyMeters").toInt()), Look.Tone.GOOD, textTag = "census-accuracy") }
                locationNote?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("census-location-note")) }
                KeyMark("coordinates", marks, requester)
            }
        }
    }
    SectionCard(CustomerMaster.ASSIGNMENT) {
        Column(pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (setup == null) Text("Connect once to download the customer lists.", style = MaterialTheme.typography.bodyMedium)
            else {
                val app = CustomerCapture.applicability(setup, form)
                CmPicker("salesOrgCode", CustomerCapture.salesOrgs(setup), form.salesOrgCode, { onChange(form.withSalesOrg(it)) }, marks, requester)
                CustomerDetailFields(listOf("salesOfficeCode"), setup, form, onChange, marks, requester)
                CmPicker("distributionChannelCode", CustomerCapture.channels(setup, form), form.distributionChannelCode,
                    { onChange(form.withChannel(it)) }, marks, requester, if (form.salesOrgCode.isEmpty()) "Choose Sales Organization first" else "Choose…")
                if (app.group1 != false) CmPicker("customerGroup1Code", CustomerCapture.group1s(setup, form), form.customerGroup1Code,
                    { onChange(form.withGroup1(it)) }, marks, requester, if (form.distributionChannelCode.isEmpty()) "Choose Distribution Channel first" else "Choose…")
                else NotApplicable("customerGroup1Code")
                if (app.group1 != false && app.group2 != false) CmPicker("customerGroup2Code", CustomerCapture.group2s(setup, form),
                    form.customerGroup2Code, { onChange(form.copy(customerGroup2Code = it)) }, marks, requester,
                    if (form.customerGroup1Code.isEmpty()) "Choose Customer Grp 1 first" else "Choose…")
                else NotApplicable("customerGroup2Code")
                CmPicker("customerGroupCode", CustomerCapture.customerGroups(setup), form.customerGroupCode,
                    { onChange(form.copy(customerGroupCode = it)) }, marks, requester)
                CmPicker("typeOfBusiness", CustomerCapture.typesOfBusiness(setup), form.typeOfBusiness,
                    { onChange(form.copy(typeOfBusiness = it)) }, marks, requester)
                CustomerDetailFields(listOf("salesPartnerCode"), setup, form, onChange, marks, requester)
            }
        }
    }
    SectionCard(CustomerMaster.PAYMENT) {
        Column(pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CustomerDetailFields(CustomerMaster.CUSTOMER_FIELDS.filter { it.section == CustomerMaster.PAYMENT }.map { it.key },
                setup, form, onChange, marks, requester)
        }
    }
    SectionCard(CustomerMaster.DELIVERY) {
        Column(pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CustomerDetailFields(listOf("deliveringPlantCode"), setup, form, onChange, marks, requester)
            Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                androidx.compose.material3.Checkbox(form.sameAsCustomer, { onChange(form.copy(sameAsCustomer = it)) },
                    modifier = Modifier.testTag("customer-sameAsCustomer"))
                Text("Ship-to is the same as the customer", style = MaterialTheme.typography.bodyMedium)
            }
            val ship = CustomerCapture.shipTo(form, geography)
            CmText("shipToParty", if (form.sameAsCustomer) ship["shipToParty"] as String else form.shipToParty,
                { onChange(form.copy(shipToParty = it)) }, marks, requester, 200, enabled = !form.sameAsCustomer)
            CmText("shipToAddress", if (form.sameAsCustomer) ship["shipToAddress"] as String else form.shipToAddress,
                { onChange(form.copy(shipToAddress = it)) }, marks, requester, 500, enabled = !form.sameAsCustomer)
            CmText("contactPerson", form.contactPerson, { onChange(form.copy(contactPerson = it)) }, marks, requester, 150)
            CmText("shipToMobileNo", ship["mobileNo"] as String, { onChange(form.copy(shipToMobileNo = it)) }, marks, requester, 20, phone, enabled = !form.sameAsCustomer)
            CmText("shipToEmail", ship["email"] as String, { onChange(form.copy(shipToEmail = it)) }, marks, requester, 200,
                androidx.compose.ui.text.input.KeyboardType.Email, enabled = !form.sameAsCustomer)
            Text("You can save missing details as a draft. Complete all required details before Submit for approval; the CDM reviews the profile after sync.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.testTag("customer-review-note"))
        }
    }
    if (form.distributionChannelCode == CustomerMaster.ADP_CHANNEL) SectionCard(CustomerMaster.ADP) {
        Column(pad, verticalArrangement = Arrangement.spacedBy(12.dp)) {
            CustomerDetailFields(CustomerMaster.CUSTOMER_FIELDS.filter { it.adp }.map { it.key }, setup, form, onChange, marks, requester)
        }
    }
}

/** The former office-only fields use the same labels, reference lists and parent filters as the web. */
@Composable
private fun CustomerDetailFields(keys: List<String>, setup: CustomerCapture.Setup?, form: CustomerCapture.Form,
    onChange: (CustomerCapture.Form) -> Unit, marks: Map<String, String>, requester: (String) -> BringIntoViewRequester) {
    for (key in keys) {
        val field = CustomerMaster.field(key)
        if (field.kind == CustomerMaster.Kind.LIST) {
            val orgScoped = key in listOf("salesOfficeCode", "deliveringPlantCode")
            val rows = if (orgScoped && form.salesOrgCode.isEmpty()) emptyList() else
                setup?.options(field.list!!, if (orgScoped) form.salesOrgCode else null).orEmpty()
            CmPicker(key, CustomerCapture.refOptions(rows), form.detail(key), { onChange(form.withDetail(key, it)) }, marks, requester,
                if (orgScoped && form.salesOrgCode.isEmpty()) "Choose Sales Organization first" else "Choose…")
        } else CmText(key, form.detail(key), { onChange(form.withDetail(key, it)) }, marks, requester, field.max ?: 20,
            if (field.kind == CustomerMaster.Kind.MONEY) androidx.compose.ui.text.input.KeyboardType.Decimal else androidx.compose.ui.text.input.KeyboardType.Text)
    }
}
@Composable
private fun NotApplicable(key: String) {
    Text("${CustomerCapture.label(key)}: does not apply to this channel", style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("customer-na-$key"))
}
