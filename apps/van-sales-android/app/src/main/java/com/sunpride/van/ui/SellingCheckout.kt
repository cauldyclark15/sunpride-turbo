package com.sunpride.van.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.sunpride.van.pos.OpeningFloat
import com.sunpride.van.selling.Peso
import com.sunpride.van.selling.QuickCash
import com.sunpride.van.selling.SellStep

/** IP-HH1: Payment and Complete steps (Itemcount patterns 6, 8, 9), shared by the van and the store. */

enum class TenderKind { CASH, OTHER, CREDIT }
data class TenderChoice(val id: String, val label: String, val kind: TenderKind)

/** CART -> PAYMENT -> COMPLETE tracker; the finished steps are green, the current one is dark. */
@Composable fun StepPills(current: SellStep) {
    val steps = listOf(SellStep.CART to "CART", SellStep.PAYMENT to "PAYMENT", SellStep.COMPLETE to "COMPLETE")
    val at = steps.indexOfFirst { it.first == current }.let { if (it < 0) 0 else it }
    Row(Modifier.fillMaxWidth().testTag("step-pills"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        steps.forEachIndexed { i, (_, label) ->
            val bg = when { i < at -> SunprideTokens.stockGreen; i == at -> SunprideTokens.barInk; else -> MaterialTheme.colorScheme.surfaceVariant }
            val fg = if (i <= at) Color.White else MaterialTheme.colorScheme.onSurface
            Surface(Modifier.weight(1f), shape = RoundedCornerShape(20.dp), color = bg) {
                Text((if (i < at) "✓ " else "") + label, Modifier.padding(vertical = 8.dp).fillMaxWidth(), color = fg, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp, textAlign = TextAlign.Center, maxLines = 1)
            }
        }
    }
}

@Composable private fun Figure(label: String, value: String, tag: String, modifier: Modifier = Modifier, big: Boolean = false, color: Color = MaterialTheme.colorScheme.onSurface) {
    // IP-INT3FIX: shrink to the room this column has so the last digit is never cut off (see FigureFit).
    BoxWithConstraints(modifier, contentAlignment = Alignment.Center) {
        val start = if (big) 34f else 26f
        val pxPerSp = with(LocalDensity.current) { 1.sp.toPx() }
        val size = FigureFit.sizeSp(value, constraints.maxWidth.toFloat(), pxPerSp, start)
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(value, fontSize = size.sp, lineHeight = (size * 1.18f).sp, fontWeight = FontWeight.ExtraBold, color = color, maxLines = 1, softWrap = false, modifier = Modifier.testTag(tag))
        }
    }
}

/**
 * Payment: Total, Tendered and Change in large type, a tender row, EXACT and quick-cash buttons, live change. EXACT pays at once
 * ([onExact]); a bill only fills Tendered and shows the change, then [onPay] confirms.
 */
@Composable fun PaymentStep(
    title: String, totalMinor: Long?, choices: List<TenderChoice>, selectedId: String, onSelect: (String) -> Unit,
    tenderedMinor: Long?, onTendered: (Long?) -> Unit, issues: List<String>, saving: Boolean, canPay: Boolean, exactEnabled: Boolean,
    onExact: () -> Unit, onPay: () -> Unit, onBack: () -> Unit, message: String? = null,
    /** IP-HH2: a split sale; cash, change and the quick-cash buttons work against this part of the total. */
    cashDueMinor: Long? = null,
    body: @Composable ColumnScope.() -> Unit = {},
) {
    val selected = choices.firstOrNull { it.id == selectedId } ?: choices.first()
    val cash = selected.kind == TenderKind.CASH
    val total = totalMinor ?: 0L
    val tendered = if (cash) tenderedMinor else if (selected.kind == TenderKind.OTHER) totalMinor else null
    val cashTotal = cashDueMinor ?: total
    val change = if (tendered != null) QuickCash.changeMinor(cashTotal, tendered) else 0L
    val short = if (cash && tendered != null) QuickCash.shortMinor(cashTotal, tendered) else 0L
    var other by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    // A different tender starts clean: no stale keypad digits from the previous one.
    LaunchedEffect(selected.id) { typed = ""; other = false }
    Scaffold(Modifier.fillMaxSize().imePadding(), containerColor = MaterialTheme.colorScheme.background, contentWindowInsets = WindowInsets.systemBars,
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
                Row(Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 64.dp).padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onBack, Modifier.heightIn(min = 56.dp).testTag("back"), enabled = !saving, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Back", fontSize = 17.sp, fontWeight = FontWeight.Bold) }
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).testTag("screen-title"))
                }
            }
        },
        bottomBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp) {
                Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton(onBack, Modifier.weight(1f).heightIn(min = 64.dp).testTag("payment-back"), enabled = !saving, shape = SunprideTokens.shapes.small, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text("Back", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold) }
                    Button(onPay, Modifier.weight(2f).heightIn(min = 64.dp).testTag("complete-sale"), enabled = canPay && !saving, shape = SunprideTokens.shapes.small,
                        colors = ButtonDefaults.buttonColors(containerColor = SunprideTokens.accessibleRed, contentColor = Color.White)) {
                        Text(if (saving) "Saving…" else if (cash && change > 0) "Complete · change ${Peso.format(change)}" else "Complete sale", fontSize = 19.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1)
                    }
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            message?.let { Text(it, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("message")) }
            StepPills(SellStep.PAYMENT)
            Surface(Modifier.fillMaxWidth(), shape = SunprideTokens.shapes.large, color = MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) {
                Row(Modifier.fillMaxWidth().padding(vertical = 14.dp, horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly, verticalAlignment = Alignment.CenterVertically) {
                    Figure("TOTAL", totalMinor?.let(Peso::format) ?: "Not ready", "checkout-total", big = true, modifier = Modifier.weight(1.3f))
                    Figure("TENDERED", tendered?.let(Peso::format) ?: "₱0.00", "checkout-tendered", modifier = Modifier.weight(1f))
                    if (short > 0) Figure("SHORT", Peso.format(short), "checkout-change", color = SunprideTokens.emptyRed, modifier = Modifier.weight(1f))
                    else Figure("CHANGE", Peso.format(change), "checkout-change", color = if (change > 0) SunprideTokens.stockGreen else MaterialTheme.colorScheme.onSurface, modifier = Modifier.weight(1f))
                }
            }
            if (issues.isNotEmpty()) SectionCard("Before you can finish") { issues.forEachIndexed { i, text -> Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("checkout-issue-$i")) } }
            if (choices.size > 1) LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.testTag("tender-row")) {
                items(choices) { choice ->
                    val on = choice.id == selected.id
                    Surface(Modifier.heightIn(min = 56.dp).clickable { onSelect(choice.id) }.testTag("pay-${choice.id}"), shape = RoundedCornerShape(28.dp),
                        color = if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, if (on) SunprideTokens.barInk else MaterialTheme.colorScheme.outline)) {
                        Box(Modifier.padding(horizontal = 20.dp).heightIn(min = 56.dp), contentAlignment = Alignment.Center) {
                            Text(choice.label, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = if (on) Color.White else MaterialTheme.colorScheme.onSurface)
                        }
                    }
                }
            }
            if (cash && totalMinor != null) {
                val buttons = listOf<Pair<String, () -> Unit>>("EXACT" to onExact) + QuickCash.choices(cashTotal).map { Peso.format(it).removeSuffix(".00") to { typed = ""; onTendered(it) } }
                buttons.chunked(3).forEach { rowButtons ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        rowButtons.forEach { (label, action) ->
                            val exact = label == "EXACT"
                            Button(action, Modifier.weight(1f).heightIn(min = 68.dp).testTag(if (exact) "pay-exact" else "quick-cash-${label.filter(Char::isDigit)}"), enabled = !saving && (!exact || exactEnabled), shape = SunprideTokens.shapes.small,
                                colors = ButtonDefaults.buttonColors(containerColor = if (exact) SunprideTokens.stockGreen else SunprideTokens.barInk, contentColor = Color.White),
                                contentPadding = PaddingValues(horizontal = 4.dp)) { Text(label, fontSize = 22.sp, fontWeight = FontWeight.ExtraBold, maxLines = 1) }
                        }
                        repeat(3 - rowButtons.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
                OutlinedButton({ other = !other }, Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("pay-other-amount"), shape = SunprideTokens.shapes.small, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text(if (other) "Hide keypad" else "Other amount", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold) }
                if (other) MoneyPad(typed, "₱0", { typed = it; onTendered(OpeningFloat.centavos(it)) }, "cash-received", enabled = !saving)
            }
            body()
        }
    }
}

/** The big green check and the three figures after a saved sale. */
@Composable fun CompleteStep(
    title: String, receivedLabel: String, totalLabel: String, changeLabel: String, headline: String,
    onNewSale: () -> Unit, secondaryLabel: String, onSecondary: () -> Unit, message: String? = null,
    body: @Composable ColumnScope.() -> Unit,
) {
    Scaffold(Modifier.fillMaxSize(), containerColor = MaterialTheme.colorScheme.background, contentWindowInsets = WindowInsets.systemBars,
        topBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 2.dp) {
                Row(Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 64.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).testTag("screen-title"))
                }
            }
        },
        bottomBar = {
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 6.dp) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onNewSale, Modifier.fillMaxWidth().heightIn(min = 76.dp).testTag("new-sale"), shape = SunprideTokens.shapes.small,
                        colors = ButtonDefaults.buttonColors(containerColor = SunprideTokens.barInk, contentColor = SunprideTokens.barYellow)) { Text("New sale", fontSize = 28.sp, fontWeight = FontWeight.ExtraBold) }
                    OutlinedButton(onSecondary, Modifier.fillMaxWidth().heightIn(min = 56.dp).testTag("sale-done"), shape = SunprideTokens.shapes.small, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline),
                        colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface)) { Text(secondaryLabel, fontSize = 18.sp, fontWeight = FontWeight.ExtraBold) }
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            message?.let { Text(it, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("message")) }
            StepPills(SellStep.COMPLETE)
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Surface(Modifier.size(72.dp), shape = CircleShape, color = SunprideTokens.stockGreen) { Box(contentAlignment = Alignment.Center) { Text("✓", fontSize = 44.sp, color = Color.White, fontWeight = FontWeight.ExtraBold) } }
                Text(headline, style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("sale-saved-note"))
            }
            Surface(Modifier.fillMaxWidth(), shape = SunprideTokens.shapes.large, color = MaterialTheme.colorScheme.surface, border = BorderStroke(2.dp, MaterialTheme.colorScheme.outline)) {
                Row(Modifier.fillMaxWidth().padding(vertical = 14.dp, horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceEvenly) {
                    Figure("RECEIVED", receivedLabel, "receipt-received", modifier = Modifier.weight(1f))
                    Figure("TOTAL", totalLabel, "receipt-total", big = true, modifier = Modifier.weight(1.2f))
                    Figure("CHANGE", changeLabel, "receipt-change", color = SunprideTokens.stockGreen, modifier = Modifier.weight(1f))
                }
            }
            body()
        }
    }
}
