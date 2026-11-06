package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.vanday.*
import java.time.Instant
import java.time.ZoneId

/** IP-HH2: the van day on the phone: one next step on Today, accepting the clerk's load, and a crew member taking over the phone. */

private data class CountDraft(val cases: String = "", val pieces: String = "", val reason: String? = null) {
    fun counted(caseBase: Long): Long? {
        if (cases.isBlank() && pieces.isBlank()) return null
        val c = cases.trim().ifEmpty { "0" }.toLongOrNull() ?: return null
        val p = pieces.trim().ifEmpty { "0" }.toLongOrNull() ?: return null
        if (c < 0 || p < 0) return null
        return runCatching { Math.addExact(Math.multiplyExact(c, if (caseBase > 1) caseBase else 1L), p) }.getOrNull()
    }
}

/** Count what the clerk sent, batch by batch. A line that differs needs a reason; the count goes to the office at the next sync. */
@Composable fun AcceptLoadScreen(c: VanController) {
    val info = c.vanDay
    val load = info?.load
    if (info == null || load == null || !load.canAccept) {
        ScreenFrame("Accept the load", c::back, action = "Done", onAction = { c.open(Page.HOME) }) { Text("There is no load waiting for you to count. Go back to Today.") }
        return
    }
    val drafts = remember(load.loadId) { mutableStateMapOf<String, CountDraft>() }
    var note by remember(load.loadId) { mutableStateOf("") }
    val counts = load.lines.associate { l -> l.key to AcceptCount(drafts[l.key]?.counted(l.caseBase), drafts[l.key]?.reason) }
    val ready = LoadAccept.ready(load.lines, counts, load.reasons)
    ScreenFrame("Accept the load", c::back, action = if (c.busy) "Saving…" else "Send my count", actionTag = "accept-load-send", enabled = ready && !c.busy,
        onAction = { c.acceptLoad(counts, note) }, footer = LoadAccept.problem(load.lines, counts, load.reasons), message = c.message) {
        SectionCard(load.documentNumber?.let { "Load $it" } ?: "Your load") {
            Text("Count what is on the truck against what the clerk sent.", style = MaterialTheme.typography.bodyLarge)
            load.clerkName?.let { Text("Loaded by $it", style = MaterialTheme.typography.bodyMedium) }
        }
        load.lines.forEach { line ->
            val draft = drafts[line.key] ?: CountDraft()
            val counted = draft.counted(line.caseBase)
            val uom = c.products.firstOrNull { it.productId == line.productId }?.uomCode ?: "PC"
            val differs = LoadAccept.differs(line, counted)
            SectionCard(line.productName) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(listOfNotNull(line.lotNumber?.let { "Batch $it" }, line.expiresAt?.let { "Expires " + Instant.ofEpochMilli(it).atZone(ZoneId.of("Asia/Manila")).toLocalDate() }).joinToString(" · "), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                    if (line.shipFirst) Text("SELL FIRST", fontWeight = FontWeight.ExtraBold, fontSize = 13.sp, color = SunprideTokens.accessibleRed)
                }
                Text("Sent: ${LoadAccept.label(line.sentBase, line.caseBase, uom)}", style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("sent-${line.key}"))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (line.caseBase > 1) Box(Modifier.weight(1f)) { LabeledField("Cases", draft.cases, { drafts[line.key] = draft.copy(cases = it.filter(Char::isDigit)) }, "count-cases-${line.key}", numeric = true, maxLength = 7, keyboardType = androidx.compose.ui.text.input.KeyboardType.Number) }
                    Box(Modifier.weight(1f)) { LabeledField(if (line.caseBase > 1) "Pieces" else uom, draft.pieces, { drafts[line.key] = draft.copy(pieces = it.filter(Char::isDigit)) }, "count-pieces-${line.key}", numeric = true, maxLength = 9, keyboardType = androidx.compose.ui.text.input.KeyboardType.Number) }
                }
                SecondaryButton("Same as sent", {
                    val cases = if (line.caseBase > 1) line.sentBase / line.caseBase else 0L
                    val pieces = if (line.caseBase > 1) line.sentBase % line.caseBase else line.sentBase
                    drafts[line.key] = CountDraft(if (line.caseBase > 1) cases.toString() else "", pieces.toString(), null)
                }, Modifier.testTag("count-same-${line.key}"))
                Text(LoadAccept.difference(line, counted, uom), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold,
                    color = if (differs) SunprideTokens.emptyRed else MaterialTheme.colorScheme.onSurface, modifier = Modifier.testTag("count-diff-${line.key}"))
                if (differs) {
                    Text("Why is it different?", style = MaterialTheme.typography.labelLarge)
                    LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(load.reasons) { r ->
                            val on = draft.reason == r
                            Surface(Modifier.heightIn(min = 48.dp).clickable { drafts[line.key] = draft.copy(reason = r) }.testTag("count-reason-${line.key}-$r"), shape = androidx.compose.foundation.shape.RoundedCornerShape(24.dp),
                                color = if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.outline)) {
                                Box(Modifier.padding(horizontal = 16.dp).heightIn(min = 48.dp), contentAlignment = Alignment.Center) { Text(LoadAccept.reasonLabel(r), color = if (on) Color.White else MaterialTheme.colorScheme.onSurface, fontWeight = FontWeight.Bold) }
                            }
                        }
                    }
                }
            }
        }
        LabeledField("Note for the office (optional)", note, { note = it }, "accept-note", maxLength = 300)
        Text("A difference of more than the office allows goes back to the clerk for a recount. You do not need a supervisor.", style = MaterialTheme.typography.bodyMedium)
    }
}

/** The ONE thing to do now, big, at the top of Today. */
@Composable fun NextStepCard(step: NextStep, enabled: Boolean, onGo: () -> Unit) {
    Surface(Modifier.fillMaxWidth().testTag("next-step"), shape = androidx.compose.foundation.shape.RoundedCornerShape(Look.cardRadius), color = Look.barInk) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(step.title, color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, lineHeight = 30.sp, modifier = Modifier.testTag("next-step-title"))
            Text(step.detail, color = Color(0xFFE6E6E8), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("next-step-detail"))
            step.button?.let { label ->
                PillButton(label, onGo, Modifier.padding(top = 6.dp).testTag("home-primary"), enabled = enabled, height = 60.dp, fontSize = 20.sp)
            }
        }
    }
}

/** Who is on the phone and which van it belongs to; a crew member switches with their PIN. Nobody is signed out. */
@Composable fun PhoneCrewCard(c: VanController) {
    val info = c.vanDay ?: return
    var switching by remember { mutableStateOf(false) }
    val on = info.onDevice
    SectionCard("This phone") {
        CrewSwitch.phoneLine(info)?.let { Text(it, style = MaterialTheme.typography.titleMedium, modifier = Modifier.testTag("phone-van")) }
        Text(c.crewPending?.let { "$it is on the phone (the office is told at the next sync)" } ?: on?.let { "${it.name} · ${it.role.replaceFirstChar { ch -> ch.uppercase() }}" } ?: (c.seller?.name ?: ""), style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("phone-person"))
        if (c.trip != null && info.members.any { it.profileId != on?.profileId }) SecondaryButton("Switch person", { switching = true }, Modifier.testTag("crew-switch"), enabled = !c.busy)
    }
    if (switching) CrewSwitchSheet(c, info) { switching = false }
}

@Composable private fun CrewSwitchSheet(c: VanController, info: VanDayInfo, onClose: () -> Unit) {
    val candidates = info.members.filter { it.profileId != info.onDevice?.profileId }
    var chosen by remember { mutableStateOf<CrewMember?>(null) }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = { if (!c.busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(12.dp).statusBarsPadding().navigationBarsPadding(), shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Who is using the phone now?", style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("crew-title"))
                Column(Modifier.weight(1f, false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Nobody is signed out. The new person types their own PIN.", style = MaterialTheme.typography.bodyMedium)
                    candidates.forEach { m ->
                        val on = m.profileId == chosen?.profileId
                        OutlinedButton({ chosen = m; pin = ""; error = null }, Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("crew-${m.profileId}"), enabled = m.hasPin && !c.busy, shape = SunprideTokens.shapes.small,
                            colors = if (on) ButtonDefaults.outlinedButtonColors(containerColor = SunprideTokens.barInk, contentColor = Color.White) else ButtonDefaults.outlinedButtonColors()) {
                            Text(m.name + " · " + m.roleLabel + if (!m.hasPin) " · no PIN yet" else "")
                        }
                    }
                    if (candidates.isEmpty()) Text("Nobody else is on this trip's crew.", style = MaterialTheme.typography.bodyLarge)
                    if (chosen != null) PinDigits(pin, { pin = it; error = null }, "crew-pin", !c.busy)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("crew-error")) }
                }
                PrimaryBottomButton(if (c.busy) "Checking…" else "Switch", { chosen?.let { m -> c.switchCrew(m, pin) { r -> if (r == null) onClose() else { error = r; pin = "" } } } }, chosen != null && pin.length >= 6 && !c.busy, "crew-go")
                SecondaryButton("Cancel", onClose, Modifier.testTag("crew-cancel"), enabled = !c.busy)
            }
        }
    }
}
