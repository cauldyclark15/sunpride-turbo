package com.sunpride.field.ui.diagnosticvisit

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.sunpride.field.storage.ActivityRules
import com.sunpride.field.ui.FieldController
import com.sunpride.field.ui.LabeledField
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.SunprideTokens
import org.json.JSONObject

/** One selectable row; selection is exposed to accessibility and tests. */
@Composable
fun ChoiceRow(label: String, selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Surface(onClick = onClick, enabled = enabled, shape = SunprideTokens.shapes.small,
        color = if (selected) MaterialTheme.colorScheme.surfaceVariant else MaterialTheme.colorScheme.surface,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = if (selected) 0.6f else 0.28f)),
        modifier = modifier.fillMaxWidth().heightIn(min = 48.dp).semantics(mergeDescendants = true) { this.selected = selected }) {
        Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween) {
            Text(label, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text(if (selected) "✓" else "", style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun Choices(title: String, options: List<Pair<String, String>>, value: String?, tag: String,
    enabled: Boolean, onChoose: (String) -> Unit) {
    SectionCard(title) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { (code, label) ->
                ChoiceRow(label, value == code, { onChoose(code) }, Modifier.testTag("$tag-$code"), enabled)
            }
        }
    }
}

/** AND-013 structured activity form for the open call; the rule decided it is needed or offered. */
@Composable
fun ActivityFormScreen(kind: String, controller: FieldController, modifier: Modifier = Modifier) {
    val sheet = controller.diagnosticCallSheet
    var choice by rememberSaveable(kind) { mutableStateOf<String?>(null) }
    var product by rememberSaveable(kind) { mutableStateOf<String?>(null) }
    var text by rememberSaveable(kind) { mutableStateOf("") }
    var compliant by rememberSaveable(kind) { mutableStateOf<Boolean?>(null) }
    val build: () -> JSONObject = {
        when (kind) {
            "merchandising" -> ActivityForms.merchandising(choice, text)
            "promotion" -> ActivityForms.promotion(text, choice)
            "inventory_check" -> ActivityForms.inventoryCheck(sheet, product, choice, text)
            "price_check" -> ActivityForms.priceCheck(sheet, product, text, compliant)
            else -> throw ActivityFormError("This activity can't be recorded on this phone")
        }
    }
    val valid = runCatching { build() }.isSuccess
    val busy = controller.busy
    Column(modifier.fillMaxSize().imePadding().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(ActivityRules.kindLabel(kind), style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("activity-form-title"))
            Text("For this visit", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (kind == "inventory_check" || kind == "price_check") {
                if (sheet == null || sheet.lines.isEmpty()) Text("No products set up for this account yet. Ask your office.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("activity-no-products"))
                else Choices("Product", sheet.lines.map { it.productId to "${it.code} · ${it.name}" }, product,
                    "activity-product", !busy) { product = it }
            }
            when (kind) {
                "merchandising" -> {
                    Choices("Display", ActivityForms.DISPLAY, choice, "activity-display", !busy) { choice = it }
                    SectionCard("Action taken") {
                        Column(Modifier.padding(16.dp)) {
                            LabeledField("What you fixed (optional)", text, { text = it },
                                Modifier.testTag("activity-text"), enabled = !busy)
                        }
                    }
                }
                "promotion" -> {
                    SectionCard("Program") {
                        Column(Modifier.padding(16.dp)) {
                            LabeledField("Promotion or program", text, { text = it },
                                Modifier.testTag("activity-text"), enabled = !busy)
                        }
                    }
                    Choices("Finding", ActivityForms.PROMOTION, choice, "activity-finding", !busy) { choice = it }
                }
                "inventory_check" -> {
                    Choices("Stock", ActivityForms.STOCK, choice, "activity-stock", !busy) { choice = it }
                    SectionCard("Quantity") {
                        Column(Modifier.padding(16.dp)) {
                            LabeledField("Units on shelf (optional)", text, { text = it },
                                Modifier.testTag("activity-text"), enabled = !busy,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                        }
                    }
                }
                "price_check" -> {
                    SectionCard("Shelf price") {
                        Column(Modifier.padding(16.dp)) {
                            LabeledField("Price in pesos", text, { text = it },
                                Modifier.testTag("activity-text"), enabled = !busy,
                                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal))
                        }
                    }
                    Choices("Matches the agreed price?", listOf("yes" to "Yes", "no" to "No"),
                        compliant?.let { if (it) "yes" else "no" }, "activity-compliant", !busy) { compliant = it == "yes" }
                }
                else -> Text("This activity can't be recorded on this phone. Ask your office.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            controller.diagnosticError?.let { Text(it, color = MaterialTheme.colorScheme.error,
                modifier = Modifier.testTag("activity-error")) }
            Spacer(Modifier.height(16.dp))
        }
        Spacer(Modifier.height(12.dp))
        PrimaryBottomButton("Save", { runCatching { build() }.onSuccess { controller.queueActivity(it) } },
            Modifier.testTag("activity-save"), !busy && valid)
    }
}
