package com.sunpride.field.ui.orders

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.sunpride.field.orders.OrderStatus
import com.sunpride.field.orders.OrderSubmission
import com.sunpride.field.ui.FieldController
import androidx.compose.ui.text.style.TextAlign
import com.sunpride.field.ui.ActionBar
import com.sunpride.field.ui.Glyph
import com.sunpride.field.ui.GlyphKind
import com.sunpride.field.ui.Look
import com.sunpride.field.ui.NoticeCard
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.StatusChip
import com.sunpride.field.ui.VisitDisplay

/**
 * SP-0088 review: line amounts, exact centavo totals and an advisory credit check.
 * Blocking rules stop Send, warnings never do. After sending the same screen
 * shows the order's sync status from the outbox.
 */
@Composable
fun OrderReviewScreen(visit: VisitDisplay, controller: FieldController, modifier: Modifier = Modifier) {
    val draft = controller.openOrderDraft ?: return
    val status = controller.orderStatus(draft)
    val totals = OrderSubmission.totals(draft)
    val checks = controller.orderChecks
    val sent = draft.submittedRequestId != null
    Column(modifier.fillMaxSize()) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(if (sent) "Order" else "Review order", style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.testTag("order-review-title"))
                Text(orderAssociation(visit, draft), style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Row {
                    StatusChip(status.label, when (status) {
                        OrderStatus.NEEDS_REVIEW -> Look.Tone.BAD
                        OrderStatus.RECEIVED -> Look.Tone.GOOD
                        else -> Look.Tone.NEUTRAL
                    }, textTag = "order-status")
                }
            }
            draft.requestedDeliveryDate?.let {
                NoticeCard("Requested delivery · $it\nOffice confirmation pending", glyph = GlyphKind.CLOCK,
                    textTag = "order-requested-delivery")
            }
            SectionCard("Products") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    draft.lines.forEachIndexed { index,line ->
                        Column(Modifier.fillMaxWidth().testTag("order-line-${line.productId}"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(line.name, style = MaterialTheme.typography.titleSmall)
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Text("${line.code} · %,d %s".format(line.quantity, line.uom), Modifier.weight(1f),
                                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Text(if (line.unitPriceMinor == null) "Priced by the office" else
                                    (if(totals.lineTotals.isNotEmpty()) totals.lineTotals[index] else OrderSubmission.lineAmount(line))?.let(OrderSubmission::money) ?: "Amount too large to preview",
                                    style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.End,
                                    modifier = Modifier.testTag("order-line-amount-${line.productId}"))
                            }
                        }
                    }
                }
            }
            SectionCard("Total") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Text(totals.text, Modifier.weight(1f).semantics(mergeDescendants = true) {}.testTag("order-totals"),
                            style = MaterialTheme.typography.bodyMedium)
                        Text(totals.amountText, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.End,
                            modifier = Modifier.testTag("order-amount"))
                    }
                    if(totals.discountMinor>0) Text("Promotion discount ${OrderSubmission.money(totals.discountMinor)}",style=MaterialTheme.typography.bodyMedium,modifier=Modifier.testTag("order-promotion-discount"))
                    totals.schemeBenefits.forEach { Text(it,style=MaterialTheme.typography.bodySmall) }
                    if(totals.earnedMinor>0) Text("Quoted deferred rebate ${OrderSubmission.money(totals.earnedMinor)}. Not an invoice discount; the office confirms and settles separately.",style=MaterialTheme.typography.bodySmall,modifier=Modifier.testTag("order-deferred-rebate"))
                    if(totals.approvalRequired) Text("Office discount approval required",style=MaterialTheme.typography.labelLarge,modifier=Modifier.testTag("order-promotion-approval"))
                    totals.officeText?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-office-lines")) }
                    draft.priceList?.let { list ->
                        Text(list.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (list.sample) Text("Sample prices", style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-sample-prices"))
                    } ?: Text("Prices: set by the office", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (!sent && checks.isNotEmpty()) SectionCard("Checks") {
                Column(Modifier.padding(start = 16.dp, end = 16.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    checks.forEach { check ->
                        Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}
                            .testTag(if (!check.blocking && check.label != "Prices") "order-credit"
                                else if (check.label == "Prices") "order-price-check"
                                else if (check.warning) "order-check-warning" else if (check.ok) "order-check-ok" else "order-check-problem"),
                            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            val bad = check.warning || !check.ok
                            val pass = !bad && (check.blocking || check.label == "Within the store's credit limit")
                            Glyph(if (pass) GlyphKind.CHECK else GlyphKind.INFO,
                                if (bad) MaterialTheme.colorScheme.error else if (pass) Look.text(Look.Tone.GOOD)
                                else MaterialTheme.colorScheme.onSurfaceVariant, 20.dp, Modifier.padding(top = 2.dp))
                            Column(Modifier.weight(1f)) {
                                if (check.warning) Text("Warning · approval needed", style = MaterialTheme.typography.labelSmall)
                                Text(check.label, style = MaterialTheme.typography.bodyMedium)
                                check.note?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                check.problem?.let { Text(it, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error) }
                            }
                        }
                    }
                }
            }
            Text(if (status == OrderStatus.RECEIVED) "The office has this order. Sent orders can't be changed."
                else if (sent) "Sent orders can't be changed. It reaches the office the next time this phone syncs."
                else "Sending queues this order on the phone. It reaches the office the next time this phone syncs, " +
                    "even if you are offline now.", style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            controller.diagnosticError?.let { message ->
                NoticeCard(message, tone = Look.Tone.BAD, textTag = "order-error")
            }
        }
        if (!sent) ActionBar {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Edit", { controller.closeOrderReview() }, Modifier.weight(1f).testTag("order-edit"),
                    !controller.busy)
                PrimaryBottomButton("Send order", { controller.submitOrder() }, Modifier.weight(1f).testTag("order-submit"),
                    !controller.busy && checks.isNotEmpty() && checks.all { it.ok || !it.blocking })
            }
        }
    }
}
