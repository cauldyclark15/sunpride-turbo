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
import com.sunpride.field.ui.PrimaryBottomButton
import com.sunpride.field.ui.SecondaryButton
import com.sunpride.field.ui.SectionCard
import com.sunpride.field.ui.VisitDisplay

/**
 * SP-0060 review step: the lines, totals (units per UOM; never an amount while prices are
 * unavailable), the rules the phone can check offline, then Send. After sending the same screen
 * shows the order's sync status from the outbox.
 */
@Composable
fun OrderReviewScreen(visit: VisitDisplay, controller: FieldController, modifier: Modifier = Modifier) {
    val draft = controller.openOrderDraft ?: return
    val status = controller.orderStatus(draft)
    val totals = OrderSubmission.totals(draft)
    val checks = controller.orderChecks
    val sent = draft.submittedRequestId != null
    Column(modifier.fillMaxSize().padding(horizontal = 20.dp, vertical = 16.dp)) {
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (sent) "Order" else "Review order", style = MaterialTheme.typography.headlineMedium,
                modifier = Modifier.testTag("order-review-title"))
            Text(orderAssociation(visit, draft), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(status.label, style = MaterialTheme.typography.titleSmall,
                color = if (status == OrderStatus.NEEDS_REVIEW) MaterialTheme.colorScheme.error
                    else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("order-status"))
            SectionCard("Products") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    draft.lines.forEach { line ->
                        Row(Modifier.fillMaxWidth().testTag("order-line-${line.productId}"),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(line.name, style = MaterialTheme.typography.bodyMedium)
                                Text(line.code, style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Text("%,d %s".format(line.quantity, line.uom), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            SectionCard("Total") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(totals.text, style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier.semantics(mergeDescendants = true) {}.testTag("order-totals"))
                    Text("Amount: priced by the office", style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.testTag("order-amount"))
                }
            }
            if (!sent && checks.isNotEmpty()) SectionCard("Checks") {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    checks.forEach { check ->
                        Row(Modifier.fillMaxWidth().semantics(mergeDescendants = true) {}
                            .testTag(if (check.ok) "order-check-ok" else "order-check-problem"),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(if (check.ok) "✓" else "!", color = if (check.ok) MaterialTheme.colorScheme.onSurfaceVariant
                                else MaterialTheme.colorScheme.error)
                            Column(Modifier.weight(1f)) {
                                Text(check.label, style = MaterialTheme.typography.bodyMedium)
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
                Text(message, color = MaterialTheme.colorScheme.error, modifier = Modifier.testTag("order-error"))
            }
            Spacer(Modifier.height(16.dp))
        }
        if (!sent) {
            Spacer(Modifier.height(12.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton("Edit", { controller.closeOrderReview() }, Modifier.weight(1f).testTag("order-edit"),
                    !controller.busy)
                PrimaryBottomButton("Send order", { controller.submitOrder() }, Modifier.weight(1f).testTag("order-submit"),
                    !controller.busy && checks.isNotEmpty() && checks.all { it.ok })
            }
        }
    }
}
