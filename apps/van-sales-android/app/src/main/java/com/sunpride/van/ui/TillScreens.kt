package com.sunpride.van.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.sunpride.van.pos.PosMoney
import com.sunpride.van.storepos.*
import java.time.Instant
import java.time.ZoneId

/**
 * IP-HH2: the store till day on the phone. X reading any time (printed, nothing stops), Z with a supervisor's PIN once every session is
 * closed, cash drop / pickup / paid out / paid in / no sale with their reasons, and the register's sessions as the office holds them
 * (a session a supervisor closed says so plainly).
 */
@Composable fun StoreReadsScreen(c: VanController) {
    val config = c.storePos.config ?: return
    val details = config.details
    val sessionOpen = c.storePos.shift != null
    var cashKind by remember { mutableStateOf<CashKind?>(null) }
    var zSheet by remember { mutableStateOf(false) }
    val sessions = TillSessions.of(details)
    val zProblem = TillSessions.zProblem(sessions, sessionOpen)
    val remote = StoreCheckout.objects(details.optJSONArray("reads"))
    val today = Instant.ofEpochMilli(System.currentTimeMillis()).atZone(ZoneId.of("Asia/Manila")).toLocalDate()
    fun readingDocument(kind: String): com.sunpride.van.printing.ReceiptDocument {
        val receipts = StoreTransactions.receipts(config, c.storePos.rows).filter { Instant.ofEpochMilli(it.optLong("soldAt")).atZone(ZoneId.of("Asia/Manila")).toLocalDate() == today }
        return Readings.document(kind, config.storeName, config.registerName, config.terminalCode, c.seller?.name, System.currentTimeMillis(), Readings.totals(receipts),
            Readings.movements(c.storePos.rows), if (kind == "Z") sessions else emptyList())
    }
    ScreenFrame("X / Z & cash", c::back, message = c.message ?: c.printMessage) {
        SectionCard("This register") {
            Text(config.registerName ?: "Register", style = MaterialTheme.typography.titleLarge)
            Text(if (sessionOpen) "Your cashier session is open" else "No cashier session of yours is open", Modifier.testTag("till-session-status"))
        }
        SectionCard("X reading") {
            Text("Sales so far today. Print it any time: nothing stops and nothing is closed. The expected cash is not shown.", style = MaterialTheme.typography.bodyMedium)
            PrimaryBottomButton("Print X reading", { c.readX(readingDocument("X")) }, sessionOpen && !c.busy, "store-x-read")
            if (!sessionOpen) Text("Open a cashier session to take an X reading.", style = MaterialTheme.typography.bodyMedium)
        }
        SectionCard("Cash in and out of the drawer") {
            CashKind.entries.forEach { k ->
                SecondaryButton(k.label, { cashKind = k }, Modifier.testTag("till-cash-${k.wire}"), enabled = sessionOpen && !c.busy)
            }
            Text(if (sessionOpen) "Drops, pickups, paid out and no sale need a supervisor's PIN." else "Open a cashier session to record cash movements.", style = MaterialTheme.typography.bodyMedium)
        }
        SectionCard("Z reading · end of the day") {
            Text("Z comes after every cashier session is closed, and a supervisor approves it with their PIN. It closes the sales day.", style = MaterialTheme.typography.bodyMedium)
            zProblem?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("store-z-problem")) }
            PrimaryBottomButton("Z reading with supervisor PIN", { zSheet = true }, zProblem == null && !c.busy, "store-z-read")
        }
        SectionCard("Sessions on this register") {
            if (sessions.isEmpty()) Text("No sessions downloaded yet. Sync to see them.", style = MaterialTheme.typography.bodyMedium)
            sessions.forEach { s ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("till-session-${s.shiftId}")) {
                    Text(listOfNotNull(s.number, s.businessDate).joinToString(" · ").ifBlank { "Session" }, style = MaterialTheme.typography.titleMedium)
                    Text(s.statusLabel, style = MaterialTheme.typography.bodyLarge, fontWeight = if (s.forceClosed) FontWeight.Bold else FontWeight.Normal,
                        color = if (s.forceClosed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface)
                    s.dayLabel?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
        remote.forEach { r ->
            SectionCard("${r.getString("kind").uppercase()} read ${r.getString("sequence")}") {
                val snap = r.getJSONObject("snapshot")
                Text(PosMoney.format(snap.getString("salesCentavos").toLong(), "PHP"))
                StoreCheckout.objects(snap.getJSONArray("tenders")).forEach { Text("${it.getString("label")} · ${PosMoney.format(it.getString("amount").toLong(), "PHP")}") }
            }
        }
        c.storePos.rows.filter { it.kind == "store.read" && it.status in setOf("pending", "sending") }.forEach {
            Text("${org.json.JSONObject(it.operationJson).getJSONObject("payload").getString("kind").uppercase()} reading saved · waiting for the office number")
        }
    }
    cashKind?.let { k -> CashSheet(c, k, Supervisors.of(details, c.seller?.profileId), details) { cashKind = null } }
    if (zSheet) ZSheet(c, Supervisors.of(details, c.seller?.profileId), { readingDocument("Z") }) { zSheet = false }
}

/** One cash movement: amount, why, a note when the reason needs one, and the supervisor's PIN for the kinds that need it. */
@Composable private fun CashSheet(c: VanController, kind: CashKind, supervisors: List<Supervisor>, details: org.json.JSONObject, onClose: () -> Unit) {
    val reasons = remember(kind) { CashReasons.forKind(kind, details) }
    var amount by remember { mutableStateOf("") }
    var reason by remember { mutableStateOf<CashReason?>(null) }
    var note by remember { mutableStateOf("") }
    var supervisor by remember { mutableStateOf<Supervisor?>(null) }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    val minor = VanRules.parseMoney(amount)
    val problem = TillPayloads.problem(kind, if (kind.hasAmount) minor else 0L, reason, note)
    val pinReady = !kind.supervisor || supervisor != null && pin.length >= 6
    Dialog(onDismissRequest = { if (!c.busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(12.dp).statusBarsPadding().navigationBarsPadding(), shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(kind.label, style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("cash-title"))
                Column(Modifier.weight(1f, false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(kind.help, style = MaterialTheme.typography.bodyMedium)
                    if (kind.hasAmount) LabeledField("Amount (₱)", amount, { amount = it; error = null }, "cash-amount", numeric = true, maxLength = 14)
                    Text("Why?", style = MaterialTheme.typography.labelLarge)
                    reasons.forEach { r ->
                        OutlinedButton({ reason = r; error = null }, Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("cash-reason-${r.code}"), shape = SunprideTokens.shapes.small,
                            colors = if (reason?.code == r.code) ButtonDefaults.outlinedButtonColors(containerColor = SunprideTokens.barInk, contentColor = androidx.compose.ui.graphics.Color.White) else ButtonDefaults.outlinedButtonColors()) { Text(r.label) }
                    }
                    if (reason?.noteRequired == true) LabeledField("Write why", note, { note = it }, "cash-note", maxLength = 300)
                    if (kind.supervisor) SupervisorPinBlock(supervisors, supervisor, { supervisor = it; error = null }, pin, { pin = it; error = null }, error, !c.busy)
                    else error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("cash-error")) }
                    problem?.let { Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.testTag("cash-problem")) }
                }
                PrimaryBottomButton(if (c.busy) "Saving…" else "Save ${kind.label.lowercase()}", {
                    c.saveCash(kind, if (kind.hasAmount) checkNotNull(minor) else 0L, checkNotNull(reason), note, supervisor, pin) { result -> if (result == null) onClose() else { error = result; pin = "" } }
                }, problem == null && pinReady && !c.busy, "cash-save")
                SecondaryButton("Cancel", onClose, Modifier.testTag("cash-cancel"), enabled = !c.busy)
            }
        }
    }
}

/** Z needs a supervisor's PIN. After it is saved the reading prints from this phone (the office numbers it when it syncs). */
@Composable private fun ZSheet(c: VanController, supervisors: List<Supervisor>, document: () -> com.sunpride.van.printing.ReceiptDocument, onClose: () -> Unit) {
    var supervisor by remember { mutableStateOf<Supervisor?>(null) }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    Dialog(onDismissRequest = { if (!c.busy) onClose() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().padding(12.dp).statusBarsPadding().navigationBarsPadding(), shape = SunprideTokens.shapes.large) {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text("Z reading", style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("z-title"))
                Column(Modifier.weight(1f, false).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text("This closes the sales day for this register. A supervisor approves it with their own PIN.", style = MaterialTheme.typography.bodyLarge)
                    SupervisorPinBlock(supervisors, supervisor, { supervisor = it; error = null }, pin, { pin = it; error = null }, error, !c.busy)
                }
                PrimaryBottomButton(if (c.busy) "Saving…" else "Approve and read Z", {
                    c.saveZ(supervisor, pin) { result -> if (result == null) { c.printReading(document()); onClose() } else { error = result; pin = "" } }
                }, supervisor != null && pin.length >= 6 && !c.busy, "z-approve")
                SecondaryButton("Cancel", onClose, Modifier.testTag("z-cancel"), enabled = !c.busy)
            }
        }
    }
}
