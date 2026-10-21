package com.sunpride.van.printing

import org.json.JSONObject
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
        val fiscal = receipt.fiscalJson?.let { JSONObject(it) }
        val registration = fiscal?.getJSONObject("registration")
        val tax=fiscal?.optJSONObject("tax")
        require(fiscal==null||fiscal.optString("documentType")=="official_receipt"||tax!=null){"Invoice tax snapshot is missing"}
        val taxLines=tax?.optJSONArray("lines")?.let{rows->(0 until rows.length()).map{rows.getJSONObject(it)}.associate{it.getInt("lineNumber") to it.getString("treatment")}}.orEmpty()
        val voidSlip = attempt.kind == PrintKind.VOID
        if (voidSlip) requireNotNull(void) { "Void slip needs cancellation evidence" }
        val reprint = attempt.kind == PrintKind.REPRINT
        val at = { ms: Long -> Instant.ofEpochMilli(ms).atZone(zone).format(time) }
        val elements = buildList {
            add(ReceiptElement.Text(registration?.getString("entityName") ?: "SUNPRIDE VAN SALES", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleHeight = true)))
            add(ReceiptElement.Text(if(fiscal?.optString("documentType")=="official_receipt") "OFFICIAL RECEIPT" else if(fiscal != null) "SALES INVOICE" else "DELIVERY RECEIPT", ReceiptStyle(ReceiptAlignment.CENTER, bold = true)))
            registration?.let { r ->
                add(ReceiptElement.Text(r.getString("branchName")))
                add(ReceiptElement.Text(r.getString("address")))
                add(ReceiptElement.Text("TIN: ${r.getString("tin")}"))
                add(ReceiptElement.Text("Permit: ${if(r.isNull("permitReference")) "NOT FILED - SAMPLE" else r.getString("permitReference")}"))
                if(r.getBoolean("sample")) add(ReceiptElement.Text("SAMPLE - NOT FILED WITH BIR",ReceiptStyle(ReceiptAlignment.CENTER,bold=true)))
            }
            if (voidSlip) add(ReceiptElement.Text("VOID - SALE CANCELLED", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleWidth = true)))
            if (reprint) add(ReceiptElement.Text("REPRINT - COPY ${attempt.copyNumber}", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleWidth = true)))
            add(ReceiptElement.Divider())
            add(ReceiptElement.Text("Receipt: ${receipt.receiptNumber}"))
            fiscal?.optString("invoiceNumber")?.takeIf {it.isNotBlank()}?.let {add(ReceiptElement.Text("Against invoice: $it"))}
            add(ReceiptElement.Text("Date: ${at(receipt.createdAt)}"))
            add(ReceiptElement.Text("Customer: ${receipt.customerName}"))
            header.sellerName?.let { add(ReceiptElement.Text("Seller: $it")) }
            header.tripNumber?.let { add(ReceiptElement.Text("Trip: $it")) }
            header.truck?.let { add(ReceiptElement.Text("Truck: $it")) }
            add(ReceiptElement.Divider())
            receipt.lines.forEach { line ->
                add(ReceiptElement.Text(line.name))
                when(taxLines[line.lineNumber]){"exempt"->add(ReceiptElement.Text("  VAT EXEMPT"));"zero_rated"->add(ReceiptElement.Text("  ZERO RATED"))}
                add(ReceiptElement.Columns("  ${line.quantityLabel} ${line.uomCode} x ${money(line.unitPriceMinor, receipt.currency)}",
                    money(line.totalMinor, receipt.currency)))
                line.promotionCode?.let { code ->
                    add(ReceiptElement.Text("  Promo $code  -${money(line.discountMinor,receipt.currency)}"))
                }
                if (line.freeBase > 0L) add(ReceiptElement.Text("  Free ${line.freeQuantityLabel ?: line.freeBase} ${line.uomCode} (${line.promotionCode ?: "promotion"})"))
            }
            add(ReceiptElement.Divider())
            receipt.lines.mapNotNull { it.priceListCode }.distinct().takeIf { it.isNotEmpty() }?.let { codes ->
                add(ReceiptElement.Text("Prices: ${codes.joinToString(", ")}"))
            }
            tax?.let { tax ->
                add(ReceiptElement.Columns("VATable sales",money(tax.getString("vatableSalesMinor").toLong(),receipt.currency)))
                add(ReceiptElement.Columns("VAT",money(tax.getString("vatMinor").toLong(),receipt.currency)))
                add(ReceiptElement.Columns("VAT exempt",money(tax.getString("vatExemptMinor").toLong(),receipt.currency)))
                add(ReceiptElement.Columns("Zero rated",money(tax.getString("zeroRatedMinor").toLong(),receipt.currency)))
            }
            if(fiscal?.optString("taxRecognition")=="payment_application_only")add(ReceiptElement.Text("Payment against invoice - no new invoice tax"))
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
            if(fiscal == null) add(ReceiptElement.Text(TestReceipts.DISCLAIMER, ReceiptStyle(ReceiptAlignment.CENTER)))
            else if(registration?.getBoolean("sample") == true) add(ReceiptElement.Text("SAMPLE ONLY - NOT A TAX DOCUMENT",ReceiptStyle(ReceiptAlignment.CENTER,bold=true)))
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
