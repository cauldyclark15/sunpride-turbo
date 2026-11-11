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
import androidx.compose.ui.text.style.TextOverflow
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
        FitText(value, if (big) 42.sp else 26.sp, Modifier.fillMaxWidth(), minSize = FigureFit.MIN_SP.sp, // IP-INT3FIX: always shrinks down to the 14sp floor before it could clip
             color = color, textAlign = TextAlign.Center, tag = tag)
    }
}

/** The big total on its own line, then two smaller figures side by side. Used by Payment and Complete. */
@Composable private fun FigureCard(totalLabel: String, totalValue: String, totalTag: String, left: Triple<String, String, String>, right: Triple<String, String, String>, rightColor: Color) {
    LookCard {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(totalLabel, fontSize = 14.sp, fontWeight = FontWeight.Bold, color = Look.muted, letterSpacing = 0.8.sp)
                FitText(totalValue, 40.sp, Modifier.weight(1f), minSize = FigureFit.MIN_SP.sp, color = Look.ink, textAlign = TextAlign.End, tag = totalTag)
            }
            Box(Modifier.fillMaxWidth().height(1.dp).background(Look.hairline))
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                Figure(left.first, left.second, left.third, Modifier.weight(1f))
                Box(Modifier.width(1.dp).height(44.dp).background(Look.hairline))
                Figure(right.first, right.second, right.third, Modifier.weight(1f), color = rightColor)
            }
        }
    }
}

/** One option tile under the quick-cash buttons (Discount, Customer...): [detail] shows what is already applied. */
data class PayOption(val label: String, val detail: String?, val tag: String, val onClick: () -> Unit, val enabled: Boolean = true, val active: Boolean = false)

@Composable private fun OptionTile(label: String, detail: String?, tag: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true, active: Boolean = false) {
    val shape = RoundedCornerShape(18.dp)
    val ink = if (enabled) Look.ink else MaterialTheme.colorScheme.onSurfaceVariant
    Box(modifier.heightIn(min = 56.dp).clip(shape).background(if (active) Look.tint else Look.sheet).border(1.5.dp, if (active) Look.accent else Look.hairline, shape)
        .clickable(enabled = enabled, onClick = onClick, role = Role.Button).testTag(tag), contentAlignment = Alignment.Center) {
        Column(Modifier.padding(horizontal = 6.dp, vertical = 6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, color = if (active && enabled) Look.accent else ink, fontSize = 15.sp, lineHeight = 18.sp, fontWeight = FontWeight.ExtraBold, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
            if (detail != null) Text(detail, color = Look.muted, fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
        }
    }
}

/**
 * Payment: Total, Tendered and Change in large type, a tender row, EXACT and quick-cash buttons, then the discount / customer
 * options, all above a Complete button that is always on screen. EXACT and the bills only fill Tendered ([onExact] never saves);
 * [onPay], the big Complete button, is the only thing that completes the sale.
 */
@OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)
@Composable fun PaymentStep(
    title: String, totalMinor: Long?, choices: List<TenderChoice>, selectedId: String, onSelect: (String) -> Unit,
    tenderedMinor: Long?, onTendered: (Long?) -> Unit, issues: List<String>, saving: Boolean, canPay: Boolean, exactEnabled: Boolean,
    onExact: () -> Unit, onPay: () -> Unit, onBack: () -> Unit, message: String? = null,
    /** IP-HH2: a split sale; cash, change and the quick-cash buttons work against this part of the total. */
    cashDueMinor: Long? = null,
    /** True while EXACT is the chosen amount (the EXACT button shows as selected). */
    exactActive: Boolean = false,
    /** Under the title: who the sale is for. */
    subtitle: String? = null,
    /** Discount / customer tiles, shown above Complete without scrolling. */
    options: List<PayOption> = emptyList(),
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
        topBar = { LookTopBar(title, onBack, backEnabled = !saving, subtitle = subtitle) },
        bottomBar = {
            Surface(color = Look.sheet, shadowElevation = 10.dp, shape = RoundedCornerShape(topStart = Look.sheetTop, topEnd = Look.sheetTop)) {
                Column(Modifier.fillMaxWidth().navigationBarsPadding()) {
                // VAN-042: a refusal after Complete sale (or the first thing still missing) shows next to the button; the
                // payment list scrolls, so a message only at its top was off screen and the tap looked like it did nothing.
                (message ?: issues.firstOrNull())?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold,
                    color = Look.ink, modifier = Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 10.dp).testTag(if (message != null) "message" else "payment-reason")) }
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    PillButton("Back", onBack, Modifier.weight(1f).testTag("payment-back"), enabled = !saving, filled = false, height = 60.dp)
                    PillButton(if (saving) "Saving…" else if (cash && change > 0) "Complete · change ${Peso.format(change)}" else "Complete sale", onPay, Modifier.weight(2f).testTag("complete-sale"), enabled = canPay && !saving, height = 60.dp, fontSize = 19.sp)
                }
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding).verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            FigureCard("TOTAL", totalMinor?.let(Peso::format) ?: "Not ready", "checkout-total",
                Triple("TENDERED", tendered?.let(Peso::format) ?: "₱0.00", "checkout-tendered"),
                if (short > 0) Triple("SHORT", Peso.format(short), "checkout-change") else Triple("CHANGE", Peso.format(change), "checkout-change"),
                if (short > 0) SunprideTokens.emptyRed else if (change > 0) SunprideTokens.stockGreen else Look.ink)
            if (issues.isNotEmpty()) SectionCard("Before you can finish") { issues.forEachIndexed { i, text -> Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, modifier = Modifier.testTag("checkout-issue-$i")) } }
            if (choices.size > 1) {
                // Up to four tenders share one row (Cash, GCash, Card, Split); more are laid out three to a row, long names on two lines.
                val grid = choices.size > 4
                @Composable fun chip(choice: TenderChoice, modifier: Modifier) {
                    val on = choice.id == selected.id
                    val fg = if (on) Color.White else Look.ink
                    Surface(modifier.heightIn(min = 48.dp).clip(CircleShape).clickable { onSelect(choice.id) }.testTag("pay-${choice.id}"), shape = CircleShape,
                        color = if (on) Look.barInk else Look.sheet, border = BorderStroke(1.5.dp, if (on) Look.barInk else Look.hairline)) {
                        Box(Modifier.padding(horizontal = 10.dp).heightIn(min = 48.dp), contentAlignment = Alignment.Center) {
                            if (grid) Text(choice.label.substringBefore(" ("), fontSize = 14.sp, lineHeight = 16.sp, fontWeight = FontWeight.ExtraBold, color = fg, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center)
                            else FitText(choice.label, 16.sp, minSize = 12.sp, color = fg, textAlign = TextAlign.Center)
                        }
                    }
                }
                Column(Modifier.fillMaxWidth().testTag("tender-row"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    (if (grid) choices.chunked(3) else listOf(choices)).forEach { rowChoices ->
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            rowChoices.forEach { chip(it, Modifier.weight(1f)) }
                            if (grid) repeat(3 - rowChoices.size) { Spacer(Modifier.weight(1f)) }
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
                            val picked = if (exact) exactActive else tendered == OpeningFloat.centavos(label.filter { it.isDigit() })
                            val shape = RoundedCornerShape(18.dp)
                            val fill = when { !on -> MaterialTheme.colorScheme.surfaceVariant; picked -> Look.accent; else -> Look.card }
                            val ink = when { !on -> MaterialTheme.colorScheme.onSurfaceVariant; picked -> Look.onAccent; exact -> Look.accent; else -> Look.ink }
                            Box(Modifier.weight(1f).heightIn(min = 56.dp).clip(shape).background(fill)
                                .border(1.5.dp, if (picked) Look.accent else Look.hairline, shape)
                                .clickable(enabled = on, onClick = action, role = Role.Button).testTag(if (exact) "pay-exact" else "quick-cash-${label.filter(Char::isDigit)}"), contentAlignment = Alignment.Center) {
                                if (exact && picked) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Glyph(GlyphKind.CHECK, ink, 20.dp); FitText(label, 22.sp, Modifier.padding(end = 4.dp), minSize = 14.sp, color = ink, textAlign = TextAlign.Center)
                                } else FitText(label, 22.sp, Modifier.padding(horizontal = 6.dp), minSize = 14.sp, color = ink, textAlign = TextAlign.Center)
                            }
                        }
                        repeat(3 - rowButtons.size) { Spacer(Modifier.weight(1f)) }
                    }
                }
            }
            val tiles = (if (cash && totalMinor != null) listOf(PayOption(if (other) "Hide keypad" else "Other amount", null, "pay-other-amount", { other = !other }, active = other)) else emptyList()) + options
            tiles.chunked(3).forEach { row ->
                Row(Modifier.fillMaxWidth().testTag("pay-options"), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    row.forEach { o -> OptionTile(o.label, o.detail, o.tag, o.onClick, Modifier.weight(1f), o.enabled && !saving, o.active) }
                    repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
                }
            }
            if (cash && other && totalMinor != null) MoneyPad(typed, "₱0", { typed = it; onTendered(OpeningFloat.centavos(it)) }, "cash-received", enabled = !saving)
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
                FitText(headline, 22.sp, Modifier.padding(horizontal = 8.dp), minSize = 13.sp, color = Look.ink, textAlign = TextAlign.Center, tag = "sale-saved-note")
            }
            FigureCard("TOTAL", totalLabel, "receipt-total", Triple("RECEIVED", receivedLabel, "receipt-received"), Triple("CHANGE", changeLabel, "receipt-change"), SunprideTokens.stockGreen)
            body()
        }
    }
}
