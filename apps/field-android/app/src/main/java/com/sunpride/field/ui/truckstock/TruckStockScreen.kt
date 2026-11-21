package com.sunpride.field.ui.truckstock

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.sunpride.field.ui.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** SP-0227: this week's loaded stock and the Saturday count. Saved on the phone, sent by the usual sync. */
@Composable
fun TruckStockScreen(c: FieldController, modifier: Modifier = Modifier) {
    val life = c.sapMasterLifetime(); val scope = rememberCoroutineScope()
    var data by remember(life) { mutableStateOf<JSONObject?>(null) }
    var refresh by remember { mutableStateOf(1) }
    var loading by remember { mutableStateOf(false) }
    val counts = remember(life) { mutableStateMapOf<String, String>() }
    val reasons = remember(life) { mutableStateMapOf<String, String?>() }
    val notes = remember(life) { mutableStateMapOf<String, String>() }
    var message by remember(life) { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(life, refresh, c.today.lastSynced) {
        loading = true; val before = life
        val next = try { withContext(Dispatchers.IO) { c.domainForms(TruckStock.KIND, true) } }
            catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; null }
        if (before == c.sapMasterLifetime()) data = next
        loading = false
    }
    val now = System.currentTimeMillis()
    val d = data?.takeIf { it.optLong("authorizationExpiresAt") > now }
    val week = runCatching { TruckStock.decode(d) }.getOrNull()
    LaunchedEffect(week?.id, week?.status) {
        week?.lines?.forEach { l ->
            if (l.counted != null && counts[l.productId] == null) counts[l.productId] = l.counted.toString()
            if (l.reasonId != null && reasons[l.productId] == null) reasons[l.productId] = l.reasonId
            if (l.note != null && notes[l.productId] == null) notes[l.productId] = l.note
        }
    }
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp).testTag("truck-stock"),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        NoticeCard("Your truck stock for this week. You are counted on what the warehouse actually loaded, not on what you asked for.")
        FieldButton({ refresh++ }, Modifier.fillMaxWidth(), enabled = !loading && !c.busy) { Text(if (loading) "Refreshing…" else "Refresh") }
        c.error?.let { NoticeCard(it, tone = Look.Tone.BAD) }
        saved?.let { NoticeCard(it, tone = Look.Tone.GOOD, glyph = GlyphKind.CHECK, modifier = Modifier.testTag("truck-stock-saved")) }
        if (d == null) { NoticeCard("Connect once today to download your truck stock. After that the count works offline.",
            tone = Look.Tone.WARN, glyph = GlyphKind.LOCK); return@Column }
        if (week == null) { EmptyState("No truck stock this week", "The office has not recorded what was loaded on your truck this week.", GlyphKind.BOX); return@Column }
        val pending = d.optJSONArray("localOperations")?.let { a -> (0 until a.length()).count { a.getJSONObject(it).optString("state") in setOf("pending", "sending", "held") } } ?: 0
        Text("Week of ${week.weekStart} · " + when (week.status) { "open" -> "Not counted yet"; "counted" -> "Counted, office to check"; else -> "Checked by the office" } +
            if (pending > 0) " · $pending waiting to send" else "", style = MaterialTheme.typography.titleSmall)
        val closed = week.status == "reviewed"
        for (line in week.lines) {
            HorizontalDivider(color = Look.hairline)
            Text(line.name, style = MaterialTheme.typography.titleMedium)
            Text("${line.code} · Asked ${line.requested} · Loaded ${line.served}" + (if (line.short > 0) " (${line.short} short)" else "") +
                " · Sold ${line.sold} · Should be left ${line.expectedLeft}", style = MaterialTheme.typography.bodySmall)
            val typed = counts[line.productId].orEmpty()
            FieldTextField(typed, { counts[line.productId] = it; message = null }, label = { Text("Counted left on truck") },
                modifier = Modifier.fillMaxWidth().testTag("truck-count-${line.code}"), enabled = !closed)
            val n = typed.trim().toLongOrNull()
            if (n != null) Text(TruckStock.difference(line, n), style = MaterialTheme.typography.bodyMedium)
            if (n != null && TruckStock.needsReason(line, n) || reasons[line.productId] != null) {
                Text("Reason", style = MaterialTheme.typography.labelLarge)
                for (r in week.reasons) ChoiceRow(r.name, reasons[line.productId] == r.id, { reasons[line.productId] = r.id; message = null }, enabled = !closed)
                FieldTextField(notes[line.productId].orEmpty(), { notes[line.productId] = it }, label = { Text("Note (optional)") },
                    modifier = Modifier.fillMaxWidth(), enabled = !closed)
            }
        }
        HorizontalDivider(color = Look.hairline)
        FieldButton({
            message = null; saved = null
            val payload = try { TruckStock.payload(week, counts, reasons, notes) } catch (e: IllegalArgumentException) { message = e.message; null }
            if (payload != null) scope.launch {
                c.queueDomain(TruckStock.OP, payload, week.id).join()
                if (c.error == null) saved = "Count saved on this phone. It sends with your next sync."
                data = withContext(Dispatchers.IO) { c.domainForms(TruckStock.KIND, false) } ?: data
            }
        }, Modifier.fillMaxWidth().testTag("truck-stock-save"), enabled = !c.busy && !closed, primary = true) {
            Text(if (week.status == "open") "Save Saturday count" else "Save corrected count")
        }
        message?.let { NoticeCard(it, tone = Look.Tone.BAD) }
    }
}
