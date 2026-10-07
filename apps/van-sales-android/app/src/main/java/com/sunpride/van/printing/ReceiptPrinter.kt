package com.sunpride.van.printing

sealed interface PrinterStatus {
    /** Service connected, not a claim that paper/temperature sensors are OK. */
    data class Ready(val serviceVersion: String, val paperStatusKnown: Boolean = false) : PrinterStatus
    data object Unavailable : PrinterStatus
    data object ServiceMissing : PrinterStatus
    data object Disconnected : PrinterStatus
    data object Timeout : PrinterStatus
    /** Only from an adapter whose hardware reports paper (VAN-017); the H10P service does not. */
    data object PaperOut : PrinterStatus
    data class Failed(val message: String) : PrinterStatus
    /** VAN-015: a Bluetooth printer is chosen but the phone cannot reach it until the seller fixes [reason]. */
    data class NeedsSetup(val reason: PrinterSetupProblem) : PrinterStatus
}

/** VAN-015: phone-side problems a seller can fix (never printer faults). */
enum class PrinterSetupProblem { NO_BLUETOOTH, BLUETOOTH_OFF, PERMISSION_DENIED, NOT_PAIRED }

/** VAN-017: what the printer says about its paper. [NOT_REPORTED] is honest "unknown", never "OK". */
enum class PaperState { OK, OUT, NOT_REPORTED }

/** VAN-017 printer check: connection, paper and the adapter's own hints, read without printing. */
data class PrinterDiagnostics(
    val status: PrinterStatus,
    val paper: PaperState = PaperState.NOT_REPORTED,
    /** H10P scanner availability hint (transaction 21); null when unknown. */
    val scannerHint: Boolean? = null,
    /** VAN-015: plain-word facts for the printer check (which printer, connection tries, last problem). */
    val details: List<String> = emptyList(),
)

data class PrinterCapabilities(
    val paperWidthMm: Int = 58,
    val charactersPerLine: Int = 32,
    val qrCode: Boolean = true,
    val barcode: Boolean = true,
    val cutter: Boolean = false,
    val cashDrawer: Boolean = false,
    val pesoGlyphVerified: Boolean = false,
)
sealed interface PrintResult {
    /** All commands accepted by the service; the vendor offers no per-job physical completion ACK. */
    data object Success : PrintResult
    data class Unsupported(val feature: String) : PrintResult
    /** Failure after beginWork may already have printed. Never automatically retry a sale receipt. */
    data class Error(val status: PrinterStatus, val mayHavePrinted: Boolean = false) : PrintResult
}
interface ReceiptPrinter {
    suspend fun connect(): PrinterStatus
    suspend fun status(): PrinterStatus
    suspend fun print(doc: ReceiptDocument): PrintResult
    suspend fun cut(): PrintResult
    suspend fun openCashDrawer(): PrintResult
    /** Connects if needed and reports connection and paper. Adapters without paper sensing keep [PaperState.NOT_REPORTED]. */
    suspend fun diagnostics(): PrinterDiagnostics = PrinterDiagnostics(connect())
    val capabilities: PrinterCapabilities
    fun close()
}
