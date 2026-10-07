package com.sunpride.van.printing.escpos

import com.sunpride.van.printing.PaperState
import com.sunpride.van.printing.PrintResult
import com.sunpride.van.printing.PrinterCapabilities
import com.sunpride.van.printing.PrinterDiagnostics
import com.sunpride.van.printing.PrinterSetupProblem
import com.sunpride.van.printing.PrinterStatus
import com.sunpride.van.printing.PrinterWords
import com.sunpride.van.printing.ReceiptDocument
import com.sunpride.van.printing.ReceiptPrinter
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** One byte pipe to a printer. Blocking calls; [EscPosPrinter] runs them on IO and bounds them. */
interface EscPosTransport {
    /** Opens the link; throws [IOException] when the printer cannot be reached. Closing from another thread aborts it. */
    fun open()
    fun write(bytes: ByteArray)
    fun flush()
    /** One reply byte within [timeoutMillis], or null when the printer said nothing. */
    fun readByte(timeoutMillis: Long): Int?
    /** Discards stale reply bytes before a status request. */
    fun drainInput()
    fun close()
}

/**
 * VAN-015: generic ESC/POS printer over any [EscPosTransport] (Bluetooth SPP in the app, a fake in tests).
 *
 * - Connect is retried [connectAttempts] times with a growing pause; each try uses a fresh transport
 *   (a closed Bluetooth socket cannot reopen) and is bounded by [connectTimeoutMillis].
 * - Before every job the printer is asked for its paper sensor (DLE EOT 4). A dead link found there is
 *   reconnected once — nothing has been sent yet, so this retry can never print a receipt twice.
 *   Printers that do not answer report paper as NOT_REPORTED, never OK.
 * - A failure after the first receipt byte is sent returns `mayHavePrinted = true` and is never retried
 *   here; the seller decides on a reprint (VAN-017 rules).
 * - [setupProblem] lets the app report Bluetooth off / permission / not paired before trying.
 */
class EscPosPrinter(
    val printerName: String,
    private val transports: () -> EscPosTransport,
    override val capabilities: PrinterCapabilities = PrinterCapabilities(cutter = false, cashDrawer = false),
    private val setupProblem: () -> PrinterSetupProblem? = { null },
    private val connectAttempts: Int = 3,
    private val retryDelayMillis: Long = 700,
    private val connectTimeoutMillis: Long = 10_000,
    private val statusTimeoutMillis: Long = 800,
    private val chunkBytes: Int = 512,
) : ReceiptPrinter {
    init { require(connectAttempts >= 1); require(chunkBytes > 0) }

    private val operations = Mutex()
    private val encoder = EscPosEncoder(capabilities.charactersPerLine, if (capabilities.paperWidthMm >= 80) 576 else 384)
    @Volatile private var transport: EscPosTransport? = null
    @Volatile private var closed = false
    @Volatile private var lastStatus: PrinterStatus = PrinterStatus.Disconnected
    @Volatile private var lastTries = 0
    @Volatile private var lastProblem: String? = null
    @Volatile private var paperSensor: Boolean? = null

    override suspend fun connect(): PrinterStatus = withContext(Dispatchers.IO) { operations.withLock { connectLocked() } }

    override suspend fun status(): PrinterStatus = if (transport != null && !closed) READY else lastStatus

    private suspend fun connectLocked(): PrinterStatus {
        if (closed) return PrinterStatus.Disconnected
        if (transport != null) return READY
        var status: PrinterStatus = PrinterStatus.Disconnected
        for (attempt in 1..connectAttempts) {
            lastTries = attempt
            setupProblem()?.let { problem ->
                lastProblem = PrinterWords.setup(problem)
                return PrinterStatus.NeedsSetup(problem).also { lastStatus = it }
            }
            val candidate = transports()
            status = open(candidate)
            if (status is PrinterStatus.Ready) {
                if (closed) { candidate.close(); return PrinterStatus.Disconnected }
                transport = candidate
                lastStatus = status
                return status
            }
            candidate.close()
            if (attempt < connectAttempts) delay(retryDelayMillis * attempt)
        }
        lastProblem = PrinterWords.status(status)
        lastStatus = status
        return status
    }

    /** Bounded open: on timeout the transport is closed, which aborts a blocking Bluetooth connect. */
    private suspend fun open(candidate: EscPosTransport): PrinterStatus = coroutineScope {
        val opening = async(Dispatchers.IO) {
            try { candidate.open(); null } catch (failure: Exception) { failure }
        }
        val failure = withTimeoutOrNull(connectTimeoutMillis) { opening.await() }
        when {
            !opening.isCompleted -> {
                candidate.close()
                opening.cancel()
                PrinterStatus.Timeout
            }
            failure == null -> READY
            failure is CancellationException -> throw failure
            else -> PrinterStatus.Disconnected
        }
    }

    private fun drop() {
        transport?.let { try { it.close() } catch (_: Exception) { /* already gone */ } }
        transport = null
        lastStatus = PrinterStatus.Disconnected
    }

    /** Asks DLE EOT 4. Throws [IOException] when the link is dead; NOT_REPORTED when the printer stays silent. */
    private fun queryPaper(link: EscPosTransport): PaperState {
        link.drainInput()
        link.write(EscPosEncoder.PAPER_STATUS_REQUEST)
        link.flush()
        val reply = link.readByte(statusTimeoutMillis) ?: return PaperState.NOT_REPORTED.also { paperSensor = false }
        return when (EscPosEncoder.paperOut(reply)) {
            null -> PaperState.NOT_REPORTED.also { paperSensor = false }
            true -> PaperState.OUT.also { paperSensor = true }
            false -> PaperState.OK.also { paperSensor = true }
        }
    }

    /** Connects, then reads the paper sensor; a dead link is reconnected once (nothing printed yet). */
    private suspend fun readyWithPaper(): Pair<PrinterStatus, PaperState> {
        repeat(2) {
            val status = connectLocked()
            val link = transport
            if (status !is PrinterStatus.Ready || link == null) return status to PaperState.NOT_REPORTED
            try {
                return status to queryPaper(link)
            } catch (failure: IOException) {
                lastProblem = "the connection dropped; reconnected"
                drop()
            }
        }
        return PrinterStatus.Disconnected.also { lastStatus = it } to PaperState.NOT_REPORTED
    }

    override suspend fun diagnostics(): PrinterDiagnostics = withContext(Dispatchers.IO) {
        operations.withLock {
            val (status, paper) = readyWithPaper()
            PrinterDiagnostics(status, paper, null, details())
        }
    }

    private fun details(): List<String> = buildList {
        add("Printer: $printerName (Bluetooth)")
        add("${capabilities.paperWidthMm} mm paper · ${capabilities.charactersPerLine} characters a line")
        if (lastTries > 0) add("Connection tries last time: $lastTries of $connectAttempts")
        paperSensor?.let { add(if (it) "Paper sensor: answers" else "Paper sensor: does not answer") }
        lastProblem?.let { add("Last problem: $it") }
    }

    override suspend fun print(doc: ReceiptDocument): PrintResult = withContext(Dispatchers.IO) {
        operations.withLock {
            // Encode first: an invalid barcode or QR fails before a single byte reaches the printer.
            val bytes = try { encoder.encode(doc) } catch (invalid: IllegalArgumentException) {
                lastProblem = "the receipt could not be laid out"
                return@withLock PrintResult.Error(PrinterStatus.Failed(invalid.message ?: "invalid receipt"))
            }
            val (status, paper) = readyWithPaper()
            if (status !is PrinterStatus.Ready) return@withLock PrintResult.Error(status)
            if (paper == PaperState.OUT) {
                lastProblem = PrinterWords.status(PrinterStatus.PaperOut)
                return@withLock PrintResult.Error(PrinterStatus.PaperOut)
            }
            val link = transport ?: return@withLock PrintResult.Error(PrinterStatus.Disconnected)
            try {
                var offset = 0
                while (offset < bytes.size) {
                    val end = minOf(bytes.size, offset + chunkBytes)
                    link.write(bytes.copyOfRange(offset, end))
                    offset = end
                }
                link.flush()
                lastProblem = null
                PrintResult.Success
            } catch (failure: IOException) {
                // Part of the job may be on paper: never resend it automatically.
                lastProblem = "the connection dropped while printing"
                drop()
                PrintResult.Error(PrinterStatus.Disconnected, mayHavePrinted = true)
            }
        }
    }

    override suspend fun cut(): PrintResult {
        if (!capabilities.cutter) return PrintResult.Unsupported("This printer has no cutter; tear the paper by hand")
        return sendRaw(EscPosEncoder.FEED_AND_CUT)
    }

    override suspend fun openCashDrawer(): PrintResult = PrintResult.Unsupported("Bluetooth printers have no cash drawer port")

    private suspend fun sendRaw(bytes: ByteArray): PrintResult = withContext(Dispatchers.IO) {
        operations.withLock {
            val status = connectLocked()
            val link = transport
            if (status !is PrinterStatus.Ready || link == null) return@withLock PrintResult.Error(status)
            try { link.write(bytes); link.flush(); PrintResult.Success } catch (_: IOException) {
                drop()
                PrintResult.Error(PrinterStatus.Disconnected, mayHavePrinted = true)
            }
        }
    }

    override fun close() {
        closed = true
        drop()
    }

    companion object {
        val READY = PrinterStatus.Ready("ESC/POS")
    }
}
