package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sunpride.van.storepos.Supervisor

/** IP-HH2: PIN entry with its own pad (no keyboard, nothing shown but dots). 6 to 12 digits, the same rule as the server. */
@Composable fun PinDigits(pin: String, onChange: (String) -> Unit, tag: String, enabled: Boolean = true) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Surface(Modifier.fillMaxWidth(), shape = SunprideTokens.shapes.small, color = MaterialTheme.colorScheme.surface) {
            Box(Modifier.fillMaxWidth().heightIn(min = 60.dp).padding(horizontal = 16.dp), contentAlignment = Alignment.Center) {
                Text(if (pin.isEmpty()) "Enter PIN" else "●".repeat(pin.length), style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.SemiBold,
                    color = if (pin.isEmpty()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag("$tag-dots"))
            }
        }
        listOf(listOf("1", "2", "3"), listOf("4", "5", "6"), listOf("7", "8", "9"), listOf("clear", "0", "back")).forEach { row ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { key ->
                    OutlinedButton({
                        onChange(when (key) { "back" -> pin.dropLast(1); "clear" -> ""; else -> if (pin.length < 12) pin + key else pin })
                    }, Modifier.weight(1f).heightIn(min = 60.dp).testTag("$tag-key-$key"), enabled = enabled, shape = SunprideTokens.shapes.small) {
                        Text(when (key) { "back" -> "⌫"; "clear" -> "C"; else -> key }, style = MaterialTheme.typography.headlineSmall)
                    }
                }
            }
        }
    }
}

/** Choose who approves, then type their PIN. A supervisor who is locked out says so in the message under the pad. */
@Composable fun SupervisorPinBlock(supervisors: List<Supervisor>, selected: Supervisor?, onSelect: (Supervisor) -> Unit, pin: String, onPin: (String) -> Unit, message: String?, enabled: Boolean = true) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("A supervisor approves with their PIN", style = MaterialTheme.typography.labelLarge)
        if (supervisors.isEmpty()) Text("No supervisor PIN is on this phone yet. Sync, or ask the office to set a supervisor PIN.", style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("no-supervisors"))
        supervisors.forEach { s ->
            val on = s.profileId == selected?.profileId
            OutlinedButton({ onSelect(s); onPin("") }, Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("supervisor-${s.profileId}"), enabled = enabled, shape = SunprideTokens.shapes.small,
                colors = if (on) ButtonDefaults.outlinedButtonColors(containerColor = SunprideTokens.barInk, contentColor = androidx.compose.ui.graphics.Color.White) else ButtonDefaults.outlinedButtonColors()) {
                Text(s.name, style = MaterialTheme.typography.titleMedium)
            }
        }
        if (selected != null) PinDigits(pin, onPin, "supervisor-pin", enabled)
        message?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("pin-message")) }
    }
}
