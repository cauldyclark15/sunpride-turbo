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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.ui.semantics.Role
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

/** CART -> PAYMENT -> COMPLETE tracker; the finished steps are red, the current one is dark. */
@Composable fun StepPills(current: SellStep) {
    val steps = listOf(SellStep.CART to "CART", SellStep.PAYMENT to "PAYMENT", SellStep.COMPLETE to "COMPLETE")
    val at = steps.indexOfFirst { it.first == current }.let { if (it < 0) 0 else it }
    Row(Modifier.fillMaxWidth().testTag("step-pills"), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        steps.forEachIndexed { i, (_, label) ->
            val bg = when { i < at -> Look.accent; i == at -> Look.barInk; else -> Look.card }
            val fg = when { i < at -> Look.onAccent; i == at -> Color.White; else -> Look.ink }
            Surface(Modifier.weight(1f), shape = CircleShape, color = bg, border = if (i > at) BorderStroke(1.dp, Look.hairline) else null) {
                Text((if (i < at) "✓ " else "") + label, Modifier.padding(vertical = 8.dp).fillMaxWidth(), color = fg, fontWeight = FontWeight.ExtraBold, fontSize = 14.sp, textAlign = TextAlign.Center, maxLines = 1)
            }
        }
    }
}

/** A labelled amount that shrinks to fit instead of clipping: the last digit of a total must never be lost. */
@Composable private fun Figure(label: String, value: String, tag: String, modifier: Modifier = Modifier, big: Boolean = false, color: Color = Look.ink) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(label, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Look.muted, letterSpacing = 0.8.sp)
        FitText(value, if (big) 44.sp else 28.sp, Modifier.fillMaxWidth(), minSize = FigureFit.MIN_SP.sp, // IP-INT3FIX: always shrinks down to the 14sp floor before it could clip
             color = color, textAlign = TextAlign.Center, tag = tag)
    }
}

/** The big total on its own line, then two smaller figures side by side. Used by Payment and Complete. */
@Composable private fun FigureCard(totalLabel: String, totalValue: String, totalTag: String, left: Triple<String, String, String>, right: Triple<String, String, String>, rightColor: Color) {
    LookCard {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Figure(totalLabel, totalValue, totalTag, Modifier.fillMaxWidth(), big = true)
            Box(Modifier.fillMaxWidth().height(1.dp).background(Look.hairline))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Figure(left.first, left.second, left.third, Modifier.weight(1f))
                Box(Modifier.width(1.dp).height(44.dp).background(Look.hairline))
                Figure(right.first, right.second, right.third, Modifier.weight(1f), color = rightColor)
            }
        }
    }
}

/**
 * Payment: Total, Tendered and Change in large type, a tender row, EXACT and quick-cash buttons, live change. EXACT pays at once
 * ([onExact]); a bill only fills Tendered and shows the change, then [onPay] confirms.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
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
        topBar = { LookTopBar(title, onBack, backEnabled = !saving) },
        bottomBar = {
            Surface(color = Look.sheet, shadowElevation = 10.dp, shape = RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop)) {
                Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PillButton("Back", onBack, Modifier.weight(1f).testTag("payment-back"), enabled = !saving, filled = false, height = 64.dp)
                    PillButton(if (saving) "Saving…" else if (cash && change > 0) "Complete · change ${Peso.format(change)}" else "Complete sale", onPay, Modifier.weight(2f).testTag("complete-sale"), enabled = canPay && !saving, height = 64.dp, fontSize = 19.sp)
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            message?.let { Text(it, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("message")) }
            StepPills(SellStep.PAYMENT)
            FigureCard("TOTAL", totalMinor?.let(Peso::format) ?: "Not ready", "checkout-total",
                Triple("TENDERED", tendered?.let(Peso::format) ?: "₱0.00", "checkout-tendered"),
                if (short > 0) Triple("SHORT", Peso.format(short), "checkout-change") else Triple("CHANGE", Peso.format(change), "checkout-change"),
                if (short > 0) SunprideTokens.emptyRed else if (change > 0) SunprideTokens.stockGreen else Look.ink)
            if (issues.isNotEmpty()) SectionCard("Before you can finish") { issues.forEachIndexed { i, text -> Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("checkout-issue-$i")) } }
            if (choices.size > 1) FlowRow(Modifier.fillMaxWidth().testTag("tender-row"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                choices.forEach { choice ->
                    val on = choice.id == selected.id
                    Surface(Modifier.heightIn(min = 52.dp).clip(CircleShape).clickable { onSelect(choice.id) }.testTag("pay-${choice.id}"), shape = CircleShape,
                        color = if (on) Look.barInk else Look.sheet, border = BorderStroke(1.5.dp, if (on) Look.barInk else Look.hairline)) {
                        Box(Modifier.padding(horizontal = 20.dp).heightIn(min = 52.dp), contentAlignment = Alignment.Center) {
                            Text(choice.label, fontSize = 17.sp, fontWeight = FontWeight.ExtraBold, color = if (on) Color.White else Look.ink, maxLines = 1)
                        }
                    }
                }
            }
            if (cash && totalMinor != null) {
                val buttons = listOf<Pair<String, () -> Unit>>("EXACT" to { typed = ""; other = false; onExact() }) + QuickCash.choices(cashTotal).map { Peso.format(it).removeSuffix(".00") to { typed = ""; onTendered(it) } }
                buttons.chunked(3).forEach { rowButtons ->
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        rowButtons.forEach { (label, action) ->
                            val exact = label == "EXACT"
                            val on = !saving && (!exact || exactEnabled)
                            val shape = RoundedCornerShape(22.dp)
                            Box(Modifier.weight(1f).heightIn(min = 68.dp).clip(shape).background(if (!on) Brush.linearGradient(listOf(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.surfaceVariant)) else if (exact) Look.gradient else Brush.linearGradient(listOf(Look.card, Look.card)))
                                .then(if (!exact) Modifier.border(1.5.dp, Look.hairline, shape) else Modifier)
                                .clickable(enabled = on, onClick = action, role = Role.Button).testTag(if (exact) "pay-exact" else "quick-cash-${label.filter(Char::isDigit)}"), contentAlignment = Alignment.Center) {
                                FitText(label, 24.sp, Modifier.padding(horizontal = 6.dp), minSize = 14.sp, color = if (!on) MaterialTheme.colorScheme.onSurfaceVariant else if (exact) Color.White else Look.ink, textAlign = TextAlign.Center)
                            }
                        }
                        repeat(3 - rowButtons.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
                PillButton(if (other) "Hide keypad" else "Other amount", { other = !other }, Modifier.testTag("pay-other-amount"), filled = false, height = 56.dp)
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
        topBar = { LookTopBar(title, null) },
        bottomBar = {
            Surface(color = Look.sheet, shadowElevation = 10.dp, shape = RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop)) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    PillButton("New sale", onNewSale, Modifier.testTag("new-sale"), height = 76.dp, fontSize = 28.sp)
                    PillButton(secondaryLabel, onSecondary, Modifier.testTag("sale-done"), filled = false, height = 56.dp)
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            message?.let { Text(it, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.testTag("message")) }
            StepPills(SellStep.COMPLETE)
            Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Surface(Modifier.size(72.dp), shape = CircleShape, color = SunprideTokens.stockGreen) { Box(contentAlignment = Alignment.Center) { Glyph(GlyphKind.CHECK, Color.White, 40.dp) } }
                Text(headline, style = MaterialTheme.typography.titleLarge, modifier = Modifier.testTag("sale-saved-note"))
            }
            FigureCard("TOTAL", totalLabel, "receipt-total", Triple("RECEIVED", receivedLabel, "receipt-received"), Triple("CHANGE", changeLabel, "receipt-change"), SunprideTokens.stockGreen)
            body()
        }
    }
}
