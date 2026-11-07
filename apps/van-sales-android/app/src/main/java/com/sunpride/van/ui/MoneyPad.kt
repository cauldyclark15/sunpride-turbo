package com.sunpride.van.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.sp
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
        Box(Modifier.fillMaxWidth().heightIn(min = 72.dp).clip(RoundedCornerShape(Look.pill)).border(1.5.dp, Look.hairline, RoundedCornerShape(Look.pill)).padding(horizontal = 20.dp),contentAlignment = Alignment.CenterEnd) {
            if (value.isEmpty()) Text(hint,style = MaterialTheme.typography.headlineMedium,color = MaterialTheme.colorScheme.onSurfaceVariant,modifier = Modifier.testTag("$tag-hint"))
            else FitText(OpeningFloat.display(value), 44.sp, Modifier.padding(vertical = 8.dp), minSize = 24.sp, color = Look.ink, textAlign = androidx.compose.ui.text.style.TextAlign.End, tag = "$tag-value")
        }
        listOf(listOf("1","2","3"),listOf("4","5","6"),listOf("7","8","9"),listOf("00","0","back")).forEach { row ->
            Row(Modifier.fillMaxWidth(),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { key ->
                    Box(Modifier.weight(1f).heightIn(min = 64.dp).clip(RoundedCornerShape(20.dp)).background(if (enabled) Look.card else MaterialTheme.colorScheme.surfaceVariant).border(1.dp, Look.hairline, RoundedCornerShape(20.dp))
                        .clickable(enabled = enabled, role = androidx.compose.ui.semantics.Role.Button) { onChange(OpeningFloat.press(value,key)) }.testTag("$tag-key-$key"),contentAlignment = Alignment.Center) {
                        Text(if (key == "back") "⌫" else key,fontSize = 28.sp,fontWeight = FontWeight.ExtraBold,color = Look.ink)
                    }
                }
            }
        }
    }
}
