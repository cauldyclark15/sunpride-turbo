package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.selling.ClaimRules
import com.sunpride.van.selling.DiscountClaim
import com.sunpride.van.selling.LegalCart
import com.sunpride.van.selling.Peso
import com.sunpride.van.selling.PrivilegeType

/**
 * IP-HH2: the statutory discount on a sale (van and store share it). The cashier picks Senior / PWD / Solo parent / Athlete / Uniformed,
 * types the name on the ID and the ID number (both required) and, in a mixed cart, which items qualify. Nothing is worked out here:
 * [com.sunpride.van.selling.Privilege] does it and the checkout shows the result.
 */
@Composable fun ClaimSheet(items: List<Pair<String, String>>, initial: DiscountClaim?, onApply: (DiscountClaim) -> Unit, onRemove: (() -> Unit)?, onClose: () -> Unit) {
    var type by remember { mutableStateOf(initial?.type) }
    var name by remember { mutableStateOf(initial?.holderName ?: "") }
    var id by remember { mutableStateOf(initial?.idNumber ?: "") }
    var some by remember { mutableStateOf(initial?.eligibleProductIds != null) }
    var chosen by remember { mutableStateOf(initial?.eligibleProductIds ?: items.map { it.first }.toSet()) }
    var tried by remember { mutableStateOf(false) }
    val claim = type?.let { DiscountClaim(it, id, name, if (some && items.size > 1) chosen else null) }
    val problem = if (claim == null) ClaimRules.typeProblem(id, name, null) else ClaimRules.problem(claim)
    Dialog(onDismissRequest = onClose, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(12.dp).statusBarsPadding().navigationBarsPadding().imePadding(), shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Senior, PWD or other discount", style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("claim-title"))
                Column(Modifier.weight(1f, false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Who is getting the discount?", style = MaterialTheme.typography.labelLarge)
                    PrivilegeType.entries.chunked(2).forEach { pair ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            pair.forEach { t ->
                                val on = t == type
                                Surface(Modifier.weight(1f).heightIn(min = 64.dp).clickable { type = t }.testTag("claim-type-${t.wire}"), shape = SunprideTokens.shapes.small,
                                    color = if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.outline)) {
                                    Box(Modifier.padding(8.dp), contentAlignment = Alignment.Center) {
                                        Text(t.label, fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, color = if (on) androidx.compose.ui.graphics.Color.White else MaterialTheme.colorScheme.onSurface)
                                    }
                                }
                            }
                            if (pair.size == 1) Spacer(Modifier.weight(1f))
                        }
                    }
                    LabeledField("Name on the ID", name, { name = it }, "claim-name", maxLength = 120)
                    LabeledField("ID number, as printed on the card", id, { id = it }, "claim-id", maxLength = 40)
                    if (items.size > 1) {
                        Confirmation("Only some items get the discount", some, { some = it }, "claim-some")
                        if (some) items.forEach { (pid, label) ->
                            Confirmation(label, pid in chosen, { on -> chosen = if (on) chosen + pid else chosen - pid }, "claim-item-$pid")
                        }
                    }
                    Text("The discount comes off the price without VAT. A bigger promotion on an item wins, and the two never add up.", style = MaterialTheme.typography.bodyMedium)
                    if (tried && problem != null) Text(problem, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("claim-problem"))
                }
                PrimaryBottomButton("Apply discount", { if (claim != null && problem == null) onApply(claim) else tried = true }, true, "claim-apply")
                if (onRemove != null) SecondaryButton("Remove discount", onRemove, Modifier.testTag("claim-remove"))
                SecondaryButton("Cancel", onClose, Modifier.testTag("claim-cancel"))
            }
        }
    }
}

/** The discount as the cashier sees it on the payment page, with what the office says (when it could be asked). */
@Composable fun ClaimSummary(claim: DiscountClaim, legal: LegalCart?, preview: VanController.ClaimPreview, onEdit: (() -> Unit)?, tail: String = "") {
    SectionCard(claim.type.label + " discount") {
        Text("${claim.holderName.trim()} · ID ${claim.idNumber.trim()}", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("claim-summary"))
        if (legal != null) {
            if (legal.applied) {
                Text("Discount −${Peso.format(legal.privilegeDiscount)}" + (if (legal.vatRemoved > 0) " · VAT removed ${Peso.format(legal.vatRemoved)}" else ""), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.testTag("claim-amounts"))
                Text("To pay ${Peso.format(legal.total)}$tail", style = MaterialTheme.typography.bodyLarge)
            } else Text("A promotion on these items is better than the discount, so no discount is taken.", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("claim-not-applied"))
        }
        val line = when (preview) {
            VanController.ClaimPreview.None -> null
            VanController.ClaimPreview.Checking -> "Checking with the office…"
            is VanController.ClaimPreview.Matches -> "The office agrees: ${Peso.format(preview.totalMinor)} to pay."
            is VanController.ClaimPreview.Differs -> "The office works out ${Peso.format(preview.serverMinor)}; this phone ${Peso.format(preview.phoneMinor)}. Sync to refresh prices and tax, then try again."
            VanController.ClaimPreview.Offline -> "Worked out on this phone. The office checks it when it syncs."
        }
        line?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (preview is VanController.ClaimPreview.Differs) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("claim-preview")) }
        if (onEdit != null) SecondaryButton("Change or remove discount", onEdit, Modifier.testTag("claim-edit"))
    }
}
