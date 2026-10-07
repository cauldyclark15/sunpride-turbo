package com.sunpride.van.printing

import com.sunpride.van.data.PaymentKind
import com.sunpride.van.data.SaleReceipt
import java.math.BigDecimal
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * VAN-017: the 58mm delivery receipt of a saved sale. A reprint carries the REPRINT banner at the top (formatter),
 * its copy number, reason and reprint time, and a closing "not the original" line, so a copy can never pass for
 * the original. Amounts use ASCII `P` (see `PesoAmounts`); dates are Manila time.
 */
object SaleReceiptDocuments {
    val MANILA: ZoneId = ZoneId.of("Asia/Manila")
    private val time = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")

    fun money(minor: Long, currency: String): String =
        if (currency == "PHP") PesoAmounts.fromCentavos(minor) else "$currency ${BigDecimal.valueOf(minor, 2).toPlainString()}"

    fun build(receipt: SaleReceipt, header: ReceiptHeader, attempt: PrintAttempt, printedAt: Long, zone: ZoneId = MANILA, void: SaleVoidInfo? = null): ReceiptDocument {
        val voidSlip = attempt.kind == PrintKind.VOID
        if (voidSlip) requireNotNull(void) { "Void slip needs cancellation evidence" }
        val reprint = attempt.kind == PrintKind.REPRINT
        val at = { ms: Long -> Instant.ofEpochMilli(ms).atZone(zone).format(time) }
        val elements = buildList {
            add(ReceiptElement.Text("SUNPRIDE VAN SALES", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleHeight = true)))
            add(ReceiptElement.Text("DELIVERY RECEIPT", ReceiptStyle(ReceiptAlignment.CENTER, bold = true)))
            if (voidSlip) add(ReceiptElement.Text("VOID - SALE CANCELLED", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleWidth = true)))
            if (reprint) add(ReceiptElement.Text("REPRINT - COPY ${attempt.copyNumber}", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleWidth = true)))
            add(ReceiptElement.Divider())
            add(ReceiptElement.Text("Receipt: ${receipt.receiptNumber}"))
            add(ReceiptElement.Text("Date: ${at(receipt.createdAt)}"))
            add(ReceiptElement.Text("Customer: ${receipt.customerName}"))
            header.sellerName?.let { add(ReceiptElement.Text("Seller: $it")) }
            header.tripNumber?.let { add(ReceiptElement.Text("Trip: $it")) }
            header.truck?.let { add(ReceiptElement.Text("Truck: $it")) }
            add(ReceiptElement.Divider())
            receipt.lines.forEach { line ->
                add(ReceiptElement.Text(line.name))
                add(ReceiptElement.Columns("  ${line.quantityLabel} ${line.uomCode} x ${money(line.unitPriceMinor, receipt.currency)}",
                    money(line.totalMinor, receipt.currency)))
            }
            add(ReceiptElement.Divider())
            add(ReceiptElement.Columns("TOTAL", money(receipt.totalMinor, receipt.currency), bold = true))
            when (receipt.paymentKind) {
                PaymentKind.CASH -> {
                    add(ReceiptElement.Columns("Cash", money(receipt.tenderedMinor, receipt.currency)))
                    add(ReceiptElement.Columns("Change", money(receipt.changeMinor, receipt.currency)))
                }
                else -> add(ReceiptElement.Columns(receipt.paymentLabel, money(receipt.totalMinor, receipt.currency)))
            }
            receipt.reference?.let { add(ReceiptElement.Text("Ref: $it")) }
            add(ReceiptElement.Text("Payment: ${paymentState(receipt.paymentStatus)}"))
            receipt.dueDate?.let { add(ReceiptElement.Text("Due: $it")) }
            add(ReceiptElement.Divider())
            if (reprint) {
                add(ReceiptElement.Text("Reprinted: ${at(printedAt)}"))
                ReprintRules.reasonLabel(attempt.reason)?.let { add(ReceiptElement.Text("Reason: $it")) }
                add(ReceiptElement.Text("** REPRINT - NOT ORIGINAL **", ReceiptStyle(ReceiptAlignment.CENTER, bold = true)))
            }
            if (voidSlip) {
                val info = checkNotNull(void)
                add(ReceiptElement.Text("Voided: ${at(info.voidedAt)}"))
                add(ReceiptElement.Text("Reason: ${com.sunpride.van.pos.VoidReasons.label(info.reasonCode)}"))
                if (info.approved) add(ReceiptElement.Text("Supervisor approved"))
                add(ReceiptElement.Text("** VOID - NOT A VALID RECEIPT **", ReceiptStyle(ReceiptAlignment.CENTER, bold = true)))
            }
            add(ReceiptElement.Qr(receipt.receiptNumber))
            add(ReceiptElement.Text(TestReceipts.DISCLAIMER, ReceiptStyle(ReceiptAlignment.CENTER)))
            add(ReceiptElement.Feed(4))
        }
        return ReceiptDocument(elements, isReprint = reprint)
    }

    private fun paymentState(status: String): String = when (status) {
        "paid" -> "Paid"
        "on_account" -> "On account"
        else -> "To be confirmed by the office"
    }
}
