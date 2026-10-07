package com.sunpride.van.printing

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.graphics.Bitmap
import android.graphics.Color
import android.os.DeadObjectException
import android.os.IBinder
import android.os.RemoteException
import com.google.zxing.BarcodeFormat
import com.google.zxing.MultiFormatWriter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import recieptservice.com.recieptservice.PrinterInterface

/** H10P 58mm embedded printer. Binding and ALL AIDL/Binder operations run on IO.
 * Binding is bounded; synchronous vendor Binder calls cannot be forcibly cancelled safely.
 * Success means commands accepted, not a paper-out/physical-completion confirmation.
 * Lifecycle owner must close this adapter. Closing is terminal; select a new adapter to reconnect.
 */
class SenraiseEmbeddedPrinter(
    context: Context,
    private val bindTimeoutMillis: Long = 5_000,
) : ReceiptPrinter {
    private val context = context.applicationContext
    private val operations = Mutex()
    private val stateLock = Any()
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var closed = false
    private var attempt: Binding? = null
    @Volatile private var remote: PrinterInterface? = null
    @Volatile private var lastStatus: PrinterStatus = PrinterStatus.Disconnected
    override val capabilities = PrinterCapabilities()
    private val formatter = ReceiptLayoutFormatter(capabilities.charactersPerLine)

    private inner class Binding : ServiceConnection {
        val result = CompletableDeferred<IBinder>()
        var binder: IBinder? = null
        var registered = false
        val death = IBinder.DeathRecipient { disconnect(this) }
        override fun onServiceConnected(name: ComponentName, service: IBinder) {
            synchronized(stateLock) {
                if (attempt === this && !closed) result.complete(service)
            }
        }
        override fun onServiceDisconnected(name: ComponentName) { disconnect(this) }
        override fun onBindingDied(name: ComponentName) { disconnect(this) }
        override fun onNullBinding(name: ComponentName) { disconnect(this) }
    }

    private fun disconnect(binding: Binding) {
        synchronized(stateLock) {
            if (attempt === binding) {
                remote = null
                lastStatus = PrinterStatus.Disconnected
                binding.result.completeExceptionally(DeadObjectException())
            }
        }
    }

    override suspend fun connect(): PrinterStatus = withContext(Dispatchers.IO) {
        operations.withLock { connectLocked() }
    }

    private suspend fun connectLocked(): PrinterStatus {
        if (synchronized(stateLock) { closed }) return PrinterStatus.Disconnected
        remote?.let { return readStatus(it) }
        if (!PrinterRegistry.hasSenraiseService(context)) {
            lastStatus = PrinterStatus.ServiceMissing
            return lastStatus
        }
        releaseBinding()
        val binding = Binding()
        try {
            synchronized(stateLock) {
                if (closed) return PrinterStatus.Disconnected
                attempt = binding
                // Hold the short local lock across registration so close cannot leak a late bind.
                binding.registered = context.bindService(
                    Intent().setPackage(PACKAGE).setClassName(PACKAGE, SERVICE),
                    binding,
                    Context.BIND_AUTO_CREATE,
                )
            }
            if (!binding.registered) {
                lastStatus = PrinterStatus.ServiceMissing
                releaseBinding()
                return lastStatus
            }
            val binder = withTimeoutOrNull(bindTimeoutMillis) { binding.result.await() }
            if (binder == null) {
                lastStatus = PrinterStatus.Timeout
                releaseBinding()
                return lastStatus
            }
            // Callbacks only hand off the binder; linkToDeath/version calls are deliberately here on IO.
            synchronized(stateLock) {
                if (attempt !== binding || closed) return PrinterStatus.Disconnected
                binding.binder = binder
                binder.linkToDeath(binding.death, 0)
                remote = PrinterInterface.Stub.asInterface(binder)
            }
            return readStatus(remote ?: return PrinterStatus.Disconnected)
        } catch (cancelled: CancellationException) {
            releaseBinding()
            throw cancelled
        } catch (failure: Exception) {
            lastStatus = failureStatus(failure)
            releaseBinding()
            return lastStatus
        }
    }

    override suspend fun status(): PrinterStatus = withContext(Dispatchers.IO) {
        operations.withLock { remote?.let { readStatus(it) } ?: lastStatus }
    }

    private fun readStatus(service: PrinterInterface): PrinterStatus = try {
        if (!service.asBinder().isBinderAlive) {
            remote = null
            PrinterStatus.Disconnected
        } else PrinterStatus.Ready(service.serviceVersion ?: "unknown")
    } catch (failure: Exception) {
        remote = null
        failureStatus(failure)
    }.also { lastStatus = it }

    /** Optional scanner availability hint; null means disconnected/query failed, not disabled. */
    suspend fun scannerStatus(): Boolean? = withContext(Dispatchers.IO) {
        operations.withLock {
            try { remote?.scannerStatus } catch (failure: Exception) {
                lastStatus = failureStatus(failure)
                null
            }
        }
    }

    override suspend fun print(doc: ReceiptDocument): PrintResult = withContext(Dispatchers.IO) {
        operations.withLock {
            serviceJobs.withLock {
                val service = remote ?: return@withLock PrintResult.Error(PrinterStatus.Disconnected)
                var begun = false
                val bitmaps = mutableListOf<Bitmap>()
                try {
                    // Validate/render every barcode before beginWork so invalid data cannot print half a job.
                    val commands = formatter.format(doc)
                    val barcodeImages = commands.filterIsInstance<ReceiptCommand.Barcode>().associateWith {
                        barcodeBitmap(it.value).also(bitmaps::add)
                    }
                    service.beginWork()
                    begun = true
                    service.setTextSize(24f) // 384 dots / 12-dot ASCII cell = 32 columns.
                    for (command in commands) {
                        when (command) {
                            is ReceiptCommand.Line -> {
                                setStyle(service, command.style)
                                service.printText(command.text + "\n")
                            }
                            is ReceiptCommand.Qr -> {
                                setStyle(service, ReceiptStyle(ReceiptAlignment.CENTER))
                                service.printQRCode(command.value.data, command.value.moduleSize, command.value.errorLevel)
                                service.nextLine(1)
                            }
                            is ReceiptCommand.Barcode -> {
                                setStyle(service, ReceiptStyle(ReceiptAlignment.CENTER))
                                service.printBitmap(barcodeImages.getValue(command))
                                service.nextLine(1)
                            }
                            is ReceiptCommand.Feed -> {
                                setStyle(service, ReceiptStyle())
                                if (command.lines > 0) service.nextLine(command.lines)
                            }
                        }
                    }
                    setStyle(service, ReceiptStyle())
                    service.endWork()
                    begun = false
                    PrintResult.Success
                } catch (failure: Exception) {
                    if (failure is CancellationException) throw failure
                    lastStatus = failureStatus(failure)
                    if (lastStatus == PrinterStatus.Disconnected) remote = null
                    PrintResult.Error(lastStatus, mayHavePrinted = begun)
                } finally {
                    // endWork is attempted even on a partial job; never leave the service buffered.
                    if (begun) try { service.endWork() } catch (_: Exception) { /* primary error retained */ }
                    bitmaps.forEach(Bitmap::recycle)
                }
            }
        }
    }

    private fun setStyle(service: PrinterInterface, style: ReceiptStyle) {
        service.setAlignment(style.alignment.ordinal)
        service.setTextBold(style.bold)
        service.setTextDoubleWidth(style.doubleWidth)
        service.setTextDoubleHeight(style.doubleHeight)
    }

    private fun barcodeBitmap(barcode: ReceiptElement.Barcode): Bitmap {
        val format = when (barcode.type) {
            ReceiptBarcodeType.CODE_128 -> BarcodeFormat.CODE_128
            ReceiptBarcodeType.EAN_13 -> BarcodeFormat.EAN_13
            ReceiptBarcodeType.EAN_8 -> BarcodeFormat.EAN_8
            ReceiptBarcodeType.UPC_A -> BarcodeFormat.UPC_A
            ReceiptBarcodeType.UPC_E -> BarcodeFormat.UPC_E
        }
        val matrix = MultiFormatWriter().encode(barcode.data, format, 384, barcode.height)
        require(matrix.width <= 384) { "Barcode is too wide for 58mm paper" }
        return Bitmap.createBitmap(matrix.width, matrix.height, Bitmap.Config.ARGB_8888).apply {
            val pixels = IntArray(matrix.width * matrix.height) { index ->
                if (matrix[index % matrix.width, index / matrix.width]) Color.BLACK else Color.WHITE
            }
            setPixels(pixels, 0, matrix.width, 0, 0, matrix.width, matrix.height)
        }
    }

    /** The vendor ABI has no paper query: the service shows its own "no paper" dialog instead (VersionCallback is internal). */
    override suspend fun diagnostics(): PrinterDiagnostics {
        val state = connect()
        return PrinterDiagnostics(state, PaperState.NOT_REPORTED, if (state is PrinterStatus.Ready) scannerStatus() else null)
    }

    override suspend fun cut(): PrintResult = PrintResult.Unsupported("H10P has no cutter; use ReceiptElement.Feed")
    override suspend fun openCashDrawer(): PrintResult = PrintResult.Unsupported("H10P has no cash drawer port")

    private fun failureStatus(failure: Exception): PrinterStatus = when (failure) {
        is DeadObjectException -> PrinterStatus.Disconnected
        is RemoteException -> PrinterStatus.Disconnected
        else -> PrinterStatus.Failed(failure.message ?: failure.javaClass.simpleName)
    }

    private fun detachBinding(): Binding? = synchronized(stateLock) {
        attempt.also { attempt = null; remote = null }
    }
    private fun releaseBinding() { detachBinding()?.let(::cleanupBinding) }
    private fun cleanupBinding(binding: Binding) {
        binding.result.completeExceptionally(DeadObjectException())
        binding.binder?.let { try { it.unlinkToDeath(binding.death, 0) } catch (_: Exception) { /* already dead */ } }
        if (binding.registered) try { context.unbindService(binding) } catch (_: IllegalArgumentException) { /* already unbound */ }
    }

    override fun close() {
        val binding = synchronized(stateLock) {
            closed = true
            lastStatus = PrinterStatus.Disconnected
            detachBinding()
        }
        // Unlinking is a Binder operation too, so a UI-thread close only schedules cleanup.
        binding?.let {
            it.result.completeExceptionally(DeadObjectException())
            cleanupScope.launch { cleanupBinding(it) }
        }
    }

    companion object {
        const val PACKAGE = "recieptservice.com.recieptservice"
        const val SERVICE = "recieptservice.com.recieptservice.service.PrinterService"
        // Multiple adapters in one process must not interleave beginWork/endWork jobs.
        private val serviceJobs = Mutex()
    }
}
