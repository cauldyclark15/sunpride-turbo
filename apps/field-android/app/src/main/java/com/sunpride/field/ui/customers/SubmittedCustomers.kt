package com.sunpride.field.ui.customers

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Base64

/** Online editing intentionally has no saved permission/cache fallback after approval. */
object SubmittedCustomerEdits {
    fun body(edits: Map<String, String>, updatedAt: Long): JSONObject = JSONObject()
        .put("expectedUpdatedAt", updatedAt).put("edits", JSONObject().apply {
            edits.forEach { (key, value) -> put(key, value.ifBlank { null } ?: JSONObject.NULL) }
        })
    fun change(edits: Map<String, String>, field: JSONObject, value: String): Map<String, String> =
        edits.toMutableMap().apply {
            put(field.getString("key"), value)
            field.optJSONArray("clears")?.let { a -> (0 until a.length()).forEach { put(a.getString(it), "") } }
        }
    fun items(o: JSONObject, key: String): List<JSONObject> = o.optJSONArray(key)?.let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }
    }.orEmpty()
    fun waiting(c: JSONObject) = c.optString("status") == "prospect" || c.optString("enrolmentStatus") == "provisional"
}

@Composable
fun SubmittedCustomersScreen(backend: FieldBackend?, onBack: () -> Unit, modifier: Modifier = Modifier, initialId: String? = null) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val epoch = remember(backend) { backend?.authorizationEpoch }
    var selected by remember { mutableStateOf(initialId) }
    var response by remember { mutableStateOf<JSONObject?>(null) }
    var rows by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var query by remember { mutableStateOf("") }
    var waitingOnly by remember { mutableStateOf(true) }
    var edits by remember(selected) { mutableStateOf<Map<String, String>>(emptyMap()) }
    val draft = rememberFormDraft(backend,"profile:${selected ?: "list"}") { o ->
        val saved=o.optJSONObject("edits") ?: JSONObject()
        edits=saved.keys().asSequence().associateWith { saved.getString(it) }
    }
    var picker by remember { mutableStateOf<JSONObject?>(null) }
    var choiceQuery by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf<String?>(null) }
    var photoKey by remember { mutableStateOf<String?>(null) }
    fun stillCurrent() = backend != null && backend.isSignedIn && backend.authorizationEpoch == epoch
    fun run(action: suspend () -> Unit) { if (!busy) scope.launch {
        busy = true; message = null
        try { check(stillCurrent()); action() }
        catch (_: Exception) { if (stillCurrent()) message = "Could not complete this request. Check your connection and reopen the profile if it changed. Your entries are still here." }
        finally { busy = false }
    } }
    fun loadList(more: Boolean = false) = run {
        val result = withContext(Dispatchers.IO) { backend!!.submittedCustomers(query, waitingOnly, if (more) cursor else null) }
        if (stillCurrent()) { rows = (if (more) rows else emptyList()) + SubmittedCustomerEdits.items(result, "rows")
            cursor = result.optString("nextCursor").takeUnless { it.isBlank() || it == "null" } }
    }
    fun open(id: String) = run {
        val result = withContext(Dispatchers.IO) { backend!!.customerProfile(id) }
        if (stillCurrent()) { selected = id; response = result }
    }
    fun preview() = run {
        val id = selected ?: return@run
        val body = SubmittedCustomerEdits.body(edits, response!!.getJSONObject("customer").getLong("updatedAt"))
        val result = withContext(Dispatchers.IO) { backend!!.customerProfile(id, body) }
        if (stillCurrent()) response = result
    }
    fun back() { if (selected != null && initialId == null) { selected = null; response = null; edits = emptyMap(); loadList() } else onBack() }
    BackHandler { back() }
    LaunchedEffect(backend) { if (initialId == null) loadList() else open(initialId) }
    val photo = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        val key = photoKey
        if (uri != null && key != null) run {
            val encoded = withContext(Dispatchers.IO) {
                // Bound decode memory before reading an image from the owner's gallery.
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                val opts = BitmapFactory.Options().apply { inSampleSize = maxOf(1, maxOf(bounds.outWidth, bounds.outHeight) / 800) }
                val bitmap = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: error("Photo unavailable")
                try {
                    val bytes = ByteArrayOutputStream(); bitmap.compress(Bitmap.CompressFormat.JPEG, 60, bytes)
                    check(bytes.size() <= 100 * 1024)
                    "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(bytes.toByteArray())
                } finally { bitmap.recycle() }
            }
            if (stillCurrent()) edits = edits + (key to encoded)
        }
    }
    val customer = response?.optJSONObject("customer")
    val editable = customer?.optBoolean("canEdit") == true && stillCurrent()
    Column(modifier.fillMaxSize().imePadding()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            SecondaryButton("Back", { back() }, enabled = !busy)
            Text(if (selected == null) "Submitted customers" else customer?.optString("customerName") ?: "Customer profile", style = MaterialTheme.typography.headlineSmall)
            Text("Draft changes stay on this phone without a connection. The office checks current access and completeness when they arrive.", style = MaterialTheme.typography.bodySmall)
            message?.let { Text(it, Modifier.testTag("profile-message")) }
            if (selected == null) {
                FieldTextField(query, { query = it }, label = { Text("Search customer") }, modifier = Modifier.fillMaxWidth())
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilterChip(waitingOnly, { waitingOnly = true; loadList() }, label = { Text("Waiting for approval") }, enabled = !busy)
                    FilterChip(!waitingOnly, { waitingOnly = false; loadList() }, label = { Text("All") }, enabled = !busy)
                }
                SecondaryButton("Search / refresh", { loadList() }, enabled = !busy)
                rows.forEach { row -> SecondaryButton("${row.optString("registeredName").takeUnless { it == "null" || it.isBlank() } ?: row.optString("customerName")} · ${if (SubmittedCustomerEdits.waiting(row)) "Waiting for approval" else "Approved / closed"}", { open(row.getString("id")) }, Modifier.fillMaxWidth(), enabled = !busy) }
                if (!busy && rows.isEmpty()) Text("No customers found.")
                if (cursor != null) SecondaryButton("Load more", { loadList(true) }, enabled = !busy)
            } else if (customer != null) {
                Text(if (SubmittedCustomerEdits.waiting(customer)) "Waiting for approval" else "Approved / closed", Modifier.testTag("profile-status"))
                if (!editable) Text("Read only. After approval only admins can edit.")
                SubmittedCustomerEdits.items(response!!, "missingFields").takeIf { it.isNotEmpty() }?.let { missing ->
                    Text("Still to complete: " + missing.map { it.getString("label") }.distinct().joinToString(", "), color = MaterialTheme.colorScheme.error)
                }
                var section = ""
                SubmittedCustomerEdits.items(response!!, "fields").forEach { field ->
                    val key = field.getString("key"); val label = field.getString("label")
                    val value = edits[key] ?: field.optString("value")
                    if (field.optString("section") != section) { section = field.optString("section"); Text(section, style = MaterialTheme.typography.titleMedium) }
                    val options = SubmittedCustomerEdits.items(field, "options")
                    when {
                        field.optString("kind") == "photo" -> SecondaryButton(if (value.isBlank()) "Choose $label" else "$label: photo selected", { photoKey = key; photo.launch("image/*") }, enabled = editable && !busy)
                        field.optString("kind") in listOf("list", "geo", "choice", "boolean") && key != "postalCode" -> PickerField(label, options.firstOrNull { it.optString("code") == value }?.optString("name") ?: value.takeIf { it.isNotBlank() }, "Choose…", { picker = field; choiceQuery = "" }, enabled = editable && !busy)
                        else -> FieldTextField(value, { edits = edits + (key to it) }, Modifier.fillMaxWidth().testTag("profile-$key"), enabled = editable && !busy, label = { Text(label) }, singleLine = true, isError = !field.isNull("error"))
                    }
                    if (!field.isNull("error")) Text(field.getString("error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                FormDraftControls(draft,JSONObject().put("edits",JSONObject(edits)),!busy)
                if (editable) SecondaryButton("Check remaining fields", { preview() }, enabled = !busy)
                SubmittedCustomerEdits.items(customer, "history").forEach { event ->
                    Text("${event.getString("actor")} · ${java.text.DateFormat.getDateTimeInstance().format(java.util.Date(event.getLong("at")))}", style = MaterialTheme.typography.titleSmall)
                    SubmittedCustomerEdits.items(event, "changes").forEach { change ->
                        fun fact(k: String) = if (change.isNull(k)) "Not set" else change.optString(k)
                        Text("${change.getString("label")}: ${fact("before")} → ${fact("after")}", style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (customer.optBoolean("historyTruncated")) Text("Showing the latest 50 changes.")
            }
            if (busy) CircularProgressIndicator()
        }
        if (editable) PrimaryBottomButton(if (busy) "Saving…" else "Save details", {
            run {
                val id = selected ?: return@run
                val body = SubmittedCustomerEdits.body(edits, customer!!.getLong("updatedAt"))
                withContext(Dispatchers.IO) { backend!!.queueCustomerProfile(id, body) }
                if (stillCurrent()) {
                    response = null; edits = emptyMap()
                    message = "Changes saved on this phone. Sync, then reopen this customer to check them."
                }
            }
        }, Modifier.padding(16.dp).navigationBarsPadding(), enabled = !busy && !draft.busy && draft.loaded && edits.isNotEmpty())
    }
    picker?.let { field -> AlertDialog(onDismissRequest = { picker = null }, title = { Text(field.getString("label")) }, text = {
        Column { FieldTextField(choiceQuery, { choiceQuery = it }, label = { Text("Search choices") })
            TextButton(onClick = { if(choiceQuery.isNotBlank()) { edits=SubmittedCustomerEdits.change(edits,field,choiceQuery); picker=null } }) { Text("Use typed value") }
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                TextButton(onClick = { edits = SubmittedCustomerEdits.change(edits, field, ""); picker = null; preview() }) { Text("Not set") }
                SubmittedCustomerEdits.items(field, "options").filter { it.getString("name").contains(choiceQuery, true) }.forEach { option ->
                    TextButton(onClick = { edits = SubmittedCustomerEdits.change(edits, field, option.getString("code")); picker = null; preview() }) { Text(option.getString("name")) }
                }
            }
        }
    }, confirmButton = { TextButton(onClick = { picker = null }) { Text("Close") } }) }
}
