package com.sunpride.field.ui

import androidx.compose.runtime.*
import androidx.compose.material3.Text
import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** Unfinished text/selections are not domain commands, money or evidence. These rows use
 * the same SQLCipher account/device/scope partition as the rest of the phone's work. */
object FieldFormDrafts {
    const val ENTITY = "local.formdraft"
    const val MAX_BYTES = 900 * 1024
    /** Keep every unfinished form; their keys are profile IDs or menu-specific names, not "draft". */
    suspend fun save(store: com.sunpride.field.storage.FieldStore, key: String, json: String?, at: Long) {
        if (json == null) store.blockLocalCache(ENTITY, key, "completed", at)
        else store.putLocalCache(ENTITY, key, json, at, "")
    }
    fun encode(value: JSONObject): String = value.toString().also {
        require(it.toByteArray(Charsets.UTF_8).size <= MAX_BYTES) { "This draft is too large. Remove a photo and retry." }
    }
}

class FormDraftState(private val read: () -> String?, private val write: (String?) -> Unit) {
    var loaded by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var message by mutableStateOf<String?>(null); private set
    suspend fun load(restore: (JSONObject) -> Unit) {
        try { val json = withContext(Dispatchers.IO) { read() }; json?.let { restore(JSONObject(it)) }; loaded = true }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { message = "Could not open the saved draft. Reopen this form to try again." }
    }
    suspend fun save(value: JSONObject) {
        if (!loaded || busy) return
        busy = true
        try { withContext(Dispatchers.IO) { write(FieldFormDrafts.encode(value)) }; message = "Draft saved on this phone. Reopen this form to continue." }
        catch (e: kotlinx.coroutines.CancellationException) { throw e }
        catch (_: Exception) { message = "Could not save the draft. Your entries are still here; try again." }
        finally { busy = false }
    }
    suspend fun clear() { withContext(Dispatchers.IO) { write(null) }; message = null }
}

@Composable
fun rememberFormDraft(controller: FieldController, key: String, restore: (JSONObject) -> Unit): FormDraftState {
    val backend = controller.formDraftBackend()
    return rememberFormDraft(backend, key, restore)
}

@Composable
fun rememberFormDraft(backend: FieldBackend?, key: String, restore: (JSONObject) -> Unit): FormDraftState {
    val epoch = backend?.authorizationEpoch
    val state = remember(backend, epoch, key) {
        fun current() { check(backend != null && backend.isSignedIn && backend.authorizationEpoch == epoch) { "Session changed" } }
        FormDraftState(read = { current(); backend!!.formDraft(key).also { current() } },
            write = { json -> current(); backend!!.saveFormDraft(key, json); current() })
    }
    val onRestore by rememberUpdatedState(restore)
    LaunchedEffect(state) { state.load { onRestore(it) } }
    return state
}

@Composable
fun FormDraftControls(state: FormDraftState, value: JSONObject, enabled: Boolean = true) = FormDraftControls(state, { value }, enabled)

@Composable
fun FormDraftControls(state: FormDraftState, value: () -> JSONObject, enabled: Boolean = true) {
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SecondaryButton(if (state.busy) "Saving draft…" else "Save as draft", { scope.launch {
            state.save(withContext(Dispatchers.IO) { value() })
        } },
            Modifier.fillMaxWidth().testTag("form-save-draft"), enabled && state.loaded && !state.busy)
        state.message?.let { Text(it, Modifier.testTag("form-draft-message")) }
    }
}
