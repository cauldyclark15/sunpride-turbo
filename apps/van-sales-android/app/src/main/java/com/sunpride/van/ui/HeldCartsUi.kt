package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sunpride.van.pos.HeldCart
import com.sunpride.van.pos.HeldLine
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * IP-HOLD: what a selling screen needs to park and recall carts. The host owns the storage (Room) and the customer; the shared
 * selling kit owns the cart, so only it can check stock and prices again on recall.
 * [autoRecall] is a cart picked elsewhere (the van's customer list) to bring into this cart as soon as the screen opens.
 */
class HeldCartsUi(
    val count: Int,
    val carts: List<HeldCart>,
    val enforceStock: Boolean = true,
    val autoRecall: HeldCart? = null,
    /** Parks the cart; [done] gets null on success, else the words to show. */
    val onHold: (name: String?, note: String?, lines: List<HeldLine>, totalLabel: String, done: (String?) -> Unit) -> Unit,
    val onRecalled: (String) -> Unit,
    val onDiscard: (String) -> Unit,
)

private val clock = DateTimeFormatter.ofPattern("h:mm a")
private fun at(ms: Long) = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault()).format(clock)

/** Hold: a name and a note, both optional. Nothing is parked until the cashier presses Hold cart. */
@Composable fun HoldCartDialog(itemCount: Int, totalLabel: String, error: String?, busy: Boolean, onHold: (String?, String?) -> Unit, onClose: () -> Unit) {
    var name by remember { mutableStateOf("") }
    var note by remember { mutableStateOf("") }
    LookSheet("Hold this cart", onClose, tag = "hold-sheet", closeTag = "hold-close", footer = {
        error?.let { Text(it, Modifier.fillMaxWidth().testTag("hold-error"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = SunprideTokens.emptyRed) }
        PillButton(if (busy) "Holding…" else "Hold cart", { onHold(name.takeIf { it.isNotBlank() }, note.takeIf { it.isNotBlank() }) }, Modifier.testTag("hold-confirm"), enabled = !busy, height = 60.dp, fontSize = 20.sp)
        PillButton("Cancel", onClose, Modifier.testTag("hold-cancel"), filled = false, height = 52.dp)
    }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("$itemCount ${if (itemCount == 1) "item" else "items"} · $totalLabel", fontSize = 17.sp, fontWeight = FontWeight.Bold, color = Look.ink, modifier = Modifier.testTag("hold-summary"))
            Text("The cart is set aside on this phone and the screen is clear for the next customer. Nothing is sold or taken out of stock.", fontSize = 14.sp, color = Look.muted)
            LabeledField("Name (optional)", name, { name = it }, "hold-name", maxLength = 40)
            LabeledField("Note (optional)", note, { note = it }, "hold-note", maxLength = 200)
        }
    }
}

/** The carts parked on this phone, newest first. Recall brings one back into an empty cart; Discard asks first. */
@Composable fun HeldCartsSheet(carts: List<HeldCart>, cartEmpty: Boolean, showCustomer: Boolean, message: String?, onRecall: (HeldCart) -> Unit, onDiscard: (HeldCart) -> Unit, onClose: () -> Unit) {
    var confirming by remember { mutableStateOf<HeldCart?>(null) }
    LookSheet("Held carts", onClose, tag = "held-sheet", fill = true, closeTag = "held-close", footer = {
        PillButton("Close", onClose, Modifier.testTag("held-done"), filled = false, height = 56.dp)
    }) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth().testTag("held-list"), contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            message?.let { m -> item { Text(m, Modifier.testTag("held-message"), fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = SunprideTokens.emptyRed) } }
            if (!cartEmpty && carts.isNotEmpty()) item { Text("Your cart has items. Hold it or clear it before you recall another.", Modifier.testTag("held-cart-busy"), fontSize = 14.sp, color = Look.muted) }
            if (carts.isEmpty()) item { Text("No held carts.", Modifier.padding(vertical = 12.dp).testTag("held-empty"), style = MaterialTheme.typography.titleMedium) }
            items(carts, key = { it.holdId }) { c ->
                Surface(Modifier.fillMaxWidth().testTag("held-${c.holdId}"), shape = RoundedCornerShape(Look.cardRadius), color = Look.card, border = BorderStroke(1.dp, Look.hairline)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(c.name, fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Look.ink, modifier = Modifier.testTag("held-name-${c.holdId}"))
                                Text(buildString {
                                    append("${c.lines.size} ${if (c.lines.size == 1) "item" else "items"} · ${c.totalLabel} · ${at(c.createdAt)}")
                                    if (showCustomer && !c.customerName.isNullOrBlank()) append(" · ${c.customerName}")
                                }, fontSize = 14.sp, color = Look.muted)
                            }
                        }
                        c.note?.let { Text(it, fontSize = 14.sp, color = Look.ink, modifier = Modifier.testTag("held-note-${c.holdId}")) }
                        Text(c.lines.joinToString(", ") { "${it.quantityBase} × ${it.name}" }, fontSize = 13.sp, color = Look.muted, maxLines = 2)
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                            PillButton("Recall", { onRecall(c) }, Modifier.weight(1f).testTag("held-recall-${c.holdId}"), enabled = cartEmpty, height = 52.dp)
                            PillButton("Discard", { confirming = c }, Modifier.weight(1f).testTag("held-discard-${c.holdId}"), filled = false, height = 52.dp)
                        }
                    }
                }
            }
        }
    }
    confirming?.let { c ->
        AlertDialog(onDismissRequest = { confirming = null }, title = { Text("Discard ${c.name}?") },
            text = { Text("This throws the held cart away. It cannot be brought back.") },
            confirmButton = { TextButton({ onDiscard(c); confirming = null }, Modifier.heightIn(min = 48.dp).testTag("held-discard-confirm")) { Text("Discard", color = SunprideTokens.emptyRed, fontWeight = FontWeight.ExtraBold) } },
            dismissButton = { TextButton({ confirming = null }, Modifier.heightIn(min = 48.dp).testTag("held-discard-cancel")) { Text("Keep it") } })
    }
}

/** After a recall that changed something: says what, so the cashier never charges a price or quantity they did not see. */
@Composable fun RecallNotesDialog(notes: List<String>, onOk: () -> Unit) {
    LookSheet("Cart recalled", onOk, tag = "recall-notes", dismissible = false, footer = {
        PillButton("OK", onOk, Modifier.testTag("recall-ok"), height = 60.dp, fontSize = 20.sp)
    }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Some things changed while it was held. Check the cart before you charge.", fontSize = 15.sp, color = Look.muted)
            notes.forEachIndexed { i, n -> Text(n, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Look.ink, modifier = Modifier.testTag("recall-note-$i")) }
        }
    }
}
