package com.sunpride.van.printing.escpos

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import com.sunpride.van.printing.PrinterCapabilities
import com.sunpride.van.printing.PrinterSetupProblem
import java.io.IOException
import java.util.UUID

/** VAN-015: the seller's chosen Bluetooth printer. Paper width decides the line length (58mm = 32, 80mm = 48). */
data class PrinterChoice(val address: String, val name: String, val paperWidthMm: Int = 58) {
    init {
        require(ADDRESS.matches(address)) { "Not a Bluetooth address" }
        require(paperWidthMm in SUPPORTED_WIDTHS)
    }
    fun capabilities() = PrinterCapabilities(
        paperWidthMm = paperWidthMm,
        charactersPerLine = if (paperWidthMm >= 80) 48 else 32,
        qrCode = true,
        barcode = true,
        cutter = false,
        cashDrawer = false,
    )
    companion object {
        val SUPPORTED_WIDTHS = setOf(58, 80)
        private val ADDRESS = Regex("^[0-9A-F]{2}(:[0-9A-F]{2}){5}$")
    }
}

/** A device already paired in Android's Bluetooth settings. */
data class PairedPrinter(val address: String, val name: String, val looksLikePrinter: Boolean)

/** Android Bluetooth access for printers. Pairing itself happens in the system Bluetooth settings. */
object BluetoothPrinters {
    /** Phone-side problem that stops any Bluetooth printing, or null when Bluetooth is usable. */
    @SuppressLint("MissingPermission")
    fun problem(context: Context): PrinterSetupProblem? {
        val adapter = adapter(context) ?: return PrinterSetupProblem.NO_BLUETOOTH
        if (!hasConnectPermission(context)) return PrinterSetupProblem.PERMISSION_DENIED
        return if (adapter.isEnabled) null else PrinterSetupProblem.BLUETOOTH_OFF
    }

    fun hasConnectPermission(context: Context): Boolean = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
        context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

    /** Paired devices, printers first. Empty when Bluetooth is off or not allowed. */
    @SuppressLint("MissingPermission")
    fun paired(context: Context): List<PairedPrinter> {
        if (problem(context) != null) return emptyList()
        val devices = try { adapter(context)?.bondedDevices.orEmpty() } catch (_: SecurityException) { emptySet() }
        return devices.map { device ->
            PairedPrinter(
                address = device.address,
                name = device.name?.takeIf { it.isNotBlank() } ?: device.address,
                looksLikePrinter = device.bluetoothClass?.majorDeviceClass == BluetoothClass.Device.Major.IMAGING,
            )
        }.sortedWith(compareBy({ !it.looksLikePrinter }, { it.name.lowercase() }))
    }

    /** Problem for a specific chosen printer (adds "not paired"). */
    @SuppressLint("MissingPermission")
    fun problemFor(context: Context, address: String): PrinterSetupProblem? {
        problem(context)?.let { return it }
        val bonded = try { adapter(context)?.bondedDevices.orEmpty().any { it.address == address } } catch (_: SecurityException) { false }
        return if (bonded) null else PrinterSetupProblem.NOT_PAIRED
    }

    fun printer(context: Context, choice: PrinterChoice): EscPosPrinter {
        val app = context.applicationContext
        return EscPosPrinter(
            printerName = choice.name,
            transports = { BluetoothSppTransport(app, choice.address) },
            capabilities = choice.capabilities(),
            setupProblem = { problemFor(app, choice.address) },
        )
    }

    private fun adapter(context: Context) =
        (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
}

/**
 * Classic Bluetooth serial (SPP / RFCOMM), what generic ESC/POS printers speak. Tries the secure socket
 * first and falls back to an insecure one, which many cheap printers need.
 */
class BluetoothSppTransport(private val context: Context, private val address: String) : EscPosTransport {
    @Volatile private var socket: BluetoothSocket? = null
    @Volatile private var closed = false

    @SuppressLint("MissingPermission")
    override fun open() {
        if (!BluetoothPrinters.hasConnectPermission(context)) throw IOException("Bluetooth permission missing")
        val adapter = (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
            ?: throw IOException("No Bluetooth")
        val device: BluetoothDevice = adapter.getRemoteDevice(address)
        val first = connect { device.createRfcommSocketToServiceRecord(SPP) }
        if (first == null) {
            if (closed) throw IOException("closed")
            connect { device.createInsecureRfcommSocketToServiceRecord(SPP) } ?: throw IOException("Printer did not accept the connection")
        }
    }

    private fun connect(create: () -> BluetoothSocket): BluetoothSocket? {
        val candidate = try { create() } catch (_: IOException) { return null }
        socket = candidate
        if (closed) { candidate.close(); throw IOException("closed") }
        return try { candidate.connect(); candidate } catch (_: IOException) {
            try { candidate.close() } catch (_: IOException) { /* already closed */ }
            socket = null
            null
        }
    }

    private fun live(): BluetoothSocket = socket?.takeIf { it.isConnected } ?: throw IOException("Not connected")
    override fun write(bytes: ByteArray) = live().outputStream.write(bytes)
    override fun flush() = live().outputStream.flush()

    override fun readByte(timeoutMillis: Long): Int? {
        val input = live().inputStream
        val deadline = SystemClock.elapsedRealtime() + timeoutMillis
        while (SystemClock.elapsedRealtime() < deadline) {
            if (input.available() > 0) return input.read().takeIf { it >= 0 }
            Thread.sleep(20)
        }
        return null
    }

    override fun drainInput() {
        val input = live().inputStream
        while (input.available() > 0) input.read()
    }

    override fun close() {
        closed = true
        try { socket?.close() } catch (_: IOException) { /* already closed */ }
        socket = null
    }

    companion object {
        /** Serial Port Profile UUID. */
        val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    }
}
