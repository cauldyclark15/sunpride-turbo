package com.sunpride.field.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
fun ChangePasswordScreen(busy: Boolean, message: String?, changed: Boolean,
    onChange: (String, String, String) -> Unit, onDone: () -> Unit, modifier: Modifier = Modifier) {
    // Deliberately not rememberSaveable: secrets never enter saved instance state.
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var visible by remember { mutableStateOf<Set<String>>(emptySet()) }
    var validation by remember { mutableStateOf<String?>(null) }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_STOP) visible = emptySet() }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    Column(modifier.fillMaxSize().padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 12.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Text("Choose a new password", style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("change-password-title"))
            if (!changed) {
                Text("Use at least 8 characters. This phone stays signed in. Other devices will need your new password.",
                    style = MaterialTheme.typography.bodyMedium)
                for ((id, label, value) in listOf(Triple("current", "Current password", current),
                    Triple("new", "New password", next), Triple("confirm", "Confirm new password", confirm))) {
                    LabeledField(label, value, {
                        when (id) { "current" -> current = it; "new" -> next = it; else -> confirm = it }
                        validation = null
                    }, Modifier.fillMaxWidth().testTag("change-password-$id"), !busy,
                        visualTransformation = if (id in visible) VisualTransformation.None else PasswordVisualTransformation(),
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                        trailingIcon = {
                            IconButton(onClick = { visible = if (id in visible) visible - id else visible + id },
                                modifier = Modifier.testTag("change-password-$id-toggle").semantics {
                                    contentDescription = if (id in visible) "Hide $label" else "Show $label"
                                }) { EyeGlyph(crossed = id in visible) }
                        })
                }
            }
            (validation ?: message)?.let {
                Text(it, color = if (changed) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.error,
                    modifier = Modifier.testTag("change-password-message"))
            }
            if (changed) Text("If you used fingerprint or face sign-in, turn it on again in Account.",
                style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(12.dp))
        PrimaryBottomButton(if (changed) "Done" else if (busy) "Changing password…" else "Change password", {
            if (changed) onDone() else {
                val problem = com.sunpride.field.auth.PasswordChange.validate(current, next, confirm)
                if (problem != null) validation = problem.text else {
                    val old = current; val password = next; val repeated = confirm
                    current = ""; next = ""; confirm = ""; visible = emptySet(); validation = null
                    onChange(old, password, repeated)
                }
            }
        }, Modifier.testTag("change-password-submit"), !busy)
    }
}
