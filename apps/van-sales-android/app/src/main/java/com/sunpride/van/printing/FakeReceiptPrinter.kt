package com.sunpride.van.printing

/** Explicit opt-in test printer, never selected for a real sale by the registry.
 * [paper] and [nextFailure] let tests drive the VAN-017 paper/error paths without hardware.
 */
class FakeReceiptPrinter(paper: PaperState = PaperState.OK) : ReceiptPrinter {
    override val capabilities = PrinterCapabilities()
    private val lock = Any()
    private val recorded = mutableListOf<ReceiptDocument>()
    private var connected = false
    @Volatile var paper: PaperState = paper
    /** The next print returns this error instead of printing (once). */
    @Volatile var nextFailure: PrintResult.Error? = null
    val documents: List<ReceiptDocument> get() = synchronized(lock) { recorded.toList() }
    override suspend fun connect(): PrinterStatus = synchronized(lock) {
        connected = true
        PrinterStatus.Ready("fake")
    }
    override suspend fun status(): PrinterStatus = synchronized(lock) {
        if (connected) PrinterStatus.Ready("fake") else PrinterStatus.Disconnected
    }
    override suspend fun diagnostics(): PrinterDiagnostics = PrinterDiagnostics(connect(), paper)
    override suspend fun print(doc: ReceiptDocument): PrintResult = synchronized(lock) {
        val failure = nextFailure
        when {
            !connected -> PrintResult.Error(PrinterStatus.Disconnected)
            paper == PaperState.OUT -> PrintResult.Error(PrinterStatus.PaperOut)
            failure != null -> { nextFailure = null; failure }
            else -> { recorded += doc.copy(elements = doc.elements.toList()); PrintResult.Success }
        }
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
