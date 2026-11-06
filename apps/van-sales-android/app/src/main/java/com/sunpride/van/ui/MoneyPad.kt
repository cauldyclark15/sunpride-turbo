package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.sunpride.van.pos.OpeningFloat

/** A big numeric pad for whole pesos. [value] is the typed digits; [hint] shows only while it is empty. */
@Composable fun MoneyPad(value: String, hint: String, onChange: (String) -> Unit, tag: String, enabled: Boolean = true) {
    Column(Modifier.fillMaxWidth(),verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Surface(Modifier.fillMaxWidth(),shape = SunprideTokens.shapes.small,color = MaterialTheme.colorScheme.surface) {
            Box(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(horizontal = 16.dp),contentAlignment = Alignment.CenterEnd) {
                if (value.isEmpty()) Text(hint,style = MaterialTheme.typography.headlineMedium,color = MaterialTheme.colorScheme.onSurfaceVariant,modifier = Modifier.testTag("$tag-hint"))
                else Text(OpeningFloat.display(value),style = MaterialTheme.typography.headlineLarge,fontWeight = FontWeight.SemiBold,modifier = Modifier.testTag("$tag-value"))
            }
        }
        listOf(listOf("1","2","3"),listOf("4","5","6"),listOf("7","8","9"),listOf("00","0","back")).forEach { row ->
            Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { key ->
                    OutlinedButton({ onChange(OpeningFloat.press(value,key)) },Modifier.weight(1f).heightIn(min = 64.dp).testTag("$tag-key-$key"),enabled = enabled,
                        shape = SunprideTokens.shapes.small) {
                        Text(if (key == "back") "⌫" else key,style = MaterialTheme.typography.headlineSmall)
                    }
                }
            }
        }
    }
}
