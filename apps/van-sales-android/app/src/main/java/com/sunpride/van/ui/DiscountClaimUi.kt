package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
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
    LookSheet("Select Discount", onClose, tag = "claim-sheet", footer = {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PillButton("Cancel", onClose, Modifier.weight(1f).testTag("claim-cancel"), filled = false, height = 56.dp)
            PillButton("Set discount", { if (claim != null && problem == null) onApply(claim) else tried = true }, Modifier.weight(1.5f).testTag("claim-apply"), height = 56.dp, fontSize = 20.sp)
        }
        if (onRemove != null) PillButton("Remove discount", onRemove, Modifier.testTag("claim-remove"), filled = false, height = 48.dp)
    }) {
        // Rows are 60dp with 8dp gaps so all five show above the buttons on a 720x1440 screen; the rest scrolls, with 24dp of air at the end.
        Column(Modifier.padding(horizontal = 20.dp).padding(top = 14.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Senior, PWD or other discount", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, modifier = Modifier.testTag("claim-title"))
            Text("Available discount", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Look.muted)
            PrivilegeType.entries.forEach { t ->
                val on = t == type
                val notch = Look.sheet
                val dash = Look.hairline
                Surface(Modifier.fillMaxWidth().heightIn(min = 60.dp).clip(RoundedCornerShape(18.dp)).clickable { type = t }.testTag("claim-type-${t.wire}"), shape = RoundedCornerShape(18.dp),
                    color = if (on) Look.tint else Look.card, border = BorderStroke(if (on) 2.dp else 1.dp, if (on) Look.accent else Look.hairline)) {
                    Row(Modifier.drawBehind {
                        // Ticket notches on both edges and a dashed tear line before the % badge, like the reference coupons.
                        val r = 9.dp.toPx()
                        drawCircle(notch, r, Offset(0f, size.height / 2))
                        drawCircle(notch, r, Offset(size.width, size.height / 2))
                        drawLine(dash, Offset(size.width - 112.dp.toPx(), 10.dp.toPx()), Offset(size.width - 112.dp.toPx(), size.height - 10.dp.toPx()), strokeWidth = 1.5.dp.toPx(),
                            pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(8f, 8f)))
                    }.padding(start = 18.dp, end = 14.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Box(Modifier.size(40.dp).clip(CircleShape).background(Look.accent), contentAlignment = Alignment.Center) { Glyph(if (on) GlyphKind.CHECK else GlyphKind.PERCENT, Look.onAccent, 22.dp) }
                        Text(t.label, Modifier.weight(1f), fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.Bold)
                        Box(Modifier.width(88.dp).clip(CircleShape).background(Look.gradient).padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
                            Text("${t.rateBps / 100}% OFF", color = Color.White, fontSize = 15.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
                        }
                    }
                }
            }
            Text("Enter the details", Modifier.padding(top = 8.dp), fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Look.muted)
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
