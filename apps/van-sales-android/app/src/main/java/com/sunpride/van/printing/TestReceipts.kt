package com.sunpride.van.printing

import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

object TestReceipts {
    const val QR_TEST_DATA = "SUNPRIDE:VAN:TEST:NOT-OFFICIAL"
    const val DISCLAIMER = "Delivery receipt only. Not a BIR official receipt."
    fun build(
        deviceModel: String,
        serviceVersion: String,
        dateTime: ZonedDateTime = ZonedDateTime.now(),
        includePesoProbe: Boolean = false,
    ): ReceiptDocument = ReceiptDocument(buildList {
        add(ReceiptElement.Text("SUNPRIDE VAN SALES", ReceiptStyle(ReceiptAlignment.CENTER, bold = true, doubleHeight = true)))
        add(ReceiptElement.Text("TEST RECEIPT - NOT AN OFFICIAL RECEIPT", ReceiptStyle(ReceiptAlignment.CENTER)))
        add(ReceiptElement.Divider())
        add(ReceiptElement.Text("Device: $deviceModel"))
        add(ReceiptElement.Text("Date: ${dateTime.format(DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm:ss XXX"))}"))
        add(ReceiptElement.Text("Printer service: $serviceVersion"))
        add(ReceiptElement.Divider())
        add(ReceiptElement.Columns("Sample hotdog 1 x", PesoAmounts.fromCentavos(12550)))
        add(ReceiptElement.Columns("Sample ham 2 x", PesoAmounts.fromCentavos(24900)))
        add(ReceiptElement.Columns("TOTAL", PesoAmounts.fromCentavos(37450), bold = true))
        if (includePesoProbe) {
            add(ReceiptElement.Text("GLYPH PROBE ONLY: P PHP ₱"))
            add(ReceiptElement.Text("Confirm ₱ visually before use."))
        }
        add(ReceiptElement.Divider())
        add(ReceiptElement.Qr(QR_TEST_DATA))
        add(ReceiptElement.Text("Test QR - no sale recorded", ReceiptStyle(ReceiptAlignment.CENTER)))
        add(ReceiptElement.Text(DISCLAIMER))
        add(ReceiptElement.Feed(4))
    })
}
