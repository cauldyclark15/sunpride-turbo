package com.sunpride.van.printing

/** Explicit opt-in test printer, never selected for a real sale by the registry. */
class FakeReceiptPrinter : ReceiptPrinter {
    override val capabilities = PrinterCapabilities()
    private val lock = Any()
    private val recorded = mutableListOf<ReceiptDocument>()
    private var connected = false
    val documents: List<ReceiptDocument> get() = synchronized(lock) { recorded.toList() }
    override suspend fun connect(): PrinterStatus = synchronized(lock) {
        connected = true
        PrinterStatus.Ready("fake")
    }
    override suspend fun status(): PrinterStatus = synchronized(lock) {
        if (connected) PrinterStatus.Ready("fake") else PrinterStatus.Disconnected
    }
    override suspend fun print(doc: ReceiptDocument): PrintResult = synchronized(lock) {
        if (!connected) PrintResult.Error(PrinterStatus.Disconnected)
        else { recorded += doc.copy(elements = doc.elements.toList()); PrintResult.Success }
    }
    override suspend fun cut(): PrintResult = PrintResult.Unsupported("cutter")
    override suspend fun openCashDrawer(): PrintResult = PrintResult.Unsupported("cash drawer")
    override fun close() { synchronized(lock) { connected = false } }
}

class NoPrinter : ReceiptPrinter {
    override val capabilities = PrinterCapabilities(qrCode = false, barcode = false)
    override suspend fun connect(): PrinterStatus = PrinterStatus.Unavailable
    override suspend fun status(): PrinterStatus = PrinterStatus.Unavailable
    override suspend fun print(doc: ReceiptDocument): PrintResult = PrintResult.Error(PrinterStatus.Unavailable)
    override suspend fun cut(): PrintResult = PrintResult.Unsupported("cutter")
    override suspend fun openCashDrawer(): PrintResult = PrintResult.Unsupported("cash drawer")
    override fun close() = Unit
}
