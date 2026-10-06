package com.sunpride.van.scanning

import android.view.KeyEvent
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.key.onPreviewKeyEvent

/** A real, focusable field, so Android keyboard-wedge events have an unambiguous target.
 * Only use on a scanner field, not globally over customer/name/password fields.
 */
fun Modifier.captureBarcodeWedge(inputs: BarcodeInputs): Modifier = onPreviewKeyEvent { event ->
    val native = event.nativeKeyEvent
    if (native.action != KeyEvent.ACTION_DOWN || native.repeatCount != 0) false
    else {
        val character = when (native.keyCode) {
            KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER -> '\n'
            KeyEvent.KEYCODE_DEL -> '\b'
            else -> native.unicodeChar.takeIf { it in 1..Char.MAX_VALUE.code }?.toChar()
        }
        if (character == null || (character.isISOControl() && character != '\n' && character != '\b')) false
        else { inputs.wedgeCharacter(character, native.eventTime); true }
    }
}

@Composable
fun WedgeScanField(inputs: BarcodeInputs, modifier: Modifier = Modifier) {
    // The preview handler consumes hardware characters; IME/manual input still has an explicit submit.
    var manual by remember { mutableStateOf("") }
    DisposableEffect(inputs) { onDispose { inputs.resetWedge() } }
    OutlinedTextField(
        value = manual,
        onValueChange = { manual = it },
        label = { Text("Focus here for handheld scanner") },
        placeholder = { Text("Scan a product barcode") },
        singleLine = true,
        modifier = modifier.fillMaxWidth().captureBarcodeWedge(inputs),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = {
            inputs.submit(manual, ScanSource.WEDGE)
            manual = ""
        }),
        keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(imeAction = androidx.compose.ui.text.input.ImeAction.Done),
    )
}
