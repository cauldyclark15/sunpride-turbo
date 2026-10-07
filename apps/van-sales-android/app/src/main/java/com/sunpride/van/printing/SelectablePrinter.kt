package com.sunpride.van.printing

import android.content.Context
import androidx.core.content.edit
import com.sunpride.van.printing.escpos.PrinterChoice
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Where the seller's Bluetooth printer choice is kept (null = the phone's own printer). */
interface PrinterChoiceStore {
    fun load(): PrinterChoice?
    fun save(choice: PrinterChoice?)
}

/** Plain app preferences: a printer address and name are not secrets. */
class SharedPrefsPrinterChoiceStore(context: Context) : PrinterChoiceStore {
    private val prefs = context.applicationContext.getSharedPreferences("printer_choice", Context.MODE_PRIVATE)
    override fun load(): PrinterChoice? {
        val address = prefs.getString(ADDRESS, null) ?: return null
        return try {
            PrinterChoice(address, prefs.getString(NAME, null) ?: address, prefs.getInt(WIDTH, 58))
        } catch (_: IllegalArgumentException) { null }
    }
    override fun save(choice: PrinterChoice?) {
        prefs.edit {
            if (choice == null) clear() else {
                putString(ADDRESS, choice.address); putString(NAME, choice.name); putInt(WIDTH, choice.paperWidthMm)
            }
        }
    }
    private companion object { const val ADDRESS = "address"; const val NAME = "name"; const val WIDTH = "paper_width_mm" }
}

/**
 * VAN-015: the one printer the app holds for its lifetime (sale receipts and the printer check), which
 * can switch between the built-in printer and a chosen Bluetooth ESC/POS printer without restarting.
 * Every call holds a lock so a switch never closes a printer in the middle of a receipt.
 */
class SelectablePrinter(
    private val store: PrinterChoiceStore,
    private val build: (PrinterChoice?) -> ReceiptPrinter,
) : ReceiptPrinter {
    private val lock = Mutex()
    @Volatile var choice: PrinterChoice? = store.load()
        private set
    @Volatile private var current: ReceiptPrinter = build(choice)
    @Volatile private var closed = false

    /** The printer in use now (for tests and adapter-specific extras). */
    val active: ReceiptPrinter get() = current

    suspend fun select(next: PrinterChoice?) = lock.withLock {
        if (closed) return@withLock
        store.save(next)
        val old = current
        choice = next
        current = build(next)
        old.close()
    }

    override val capabilities: PrinterCapabilities get() = current.capabilities
    override suspend fun connect(): PrinterStatus = lock.withLock { current.connect() }
    override suspend fun status(): PrinterStatus = lock.withLock { current.status() }
    override suspend fun print(doc: ReceiptDocument): PrintResult = lock.withLock { current.print(doc) }
    override suspend fun cut(): PrintResult = lock.withLock { current.cut() }
    override suspend fun openCashDrawer(): PrintResult = lock.withLock { current.openCashDrawer() }
    override suspend fun diagnostics(): PrinterDiagnostics = lock.withLock { current.diagnostics() }
    override fun close() {
        closed = true
        current.close()
    }
}
