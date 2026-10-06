package com.sunpride.van.printing

sealed interface PrinterStatus {
    /** Service connected, not a claim that paper/temperature sensors are OK. */
    data class Ready(val serviceVersion: String, val paperStatusKnown: Boolean = false) : PrinterStatus
    data object Unavailable : PrinterStatus
    data object ServiceMissing : PrinterStatus
    data object Disconnected : PrinterStatus
    data object Timeout : PrinterStatus
    data class Failed(val message: String) : PrinterStatus
}

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
    val capabilities: PrinterCapabilities
    fun close()
}
