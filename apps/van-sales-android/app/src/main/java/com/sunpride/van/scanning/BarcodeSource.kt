package com.sunpride.van.scanning

import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.asSharedFlow

enum class ScanSource { BROADCAST, WEDGE, CAMERA }
data class ScanEvent(val code: String, val source: ScanSource, val receivedAtMillis: Long)
interface BarcodeSource { val scans: Flow<ScanEvent> }

/** Monotonic-time deduplication across ALL sources; repeated intentional scans after 300ms pass. */
class ScanDeduplicator(private val windowMillis: Long = 300) {
    init { require(windowMillis >= 0) }
    private val recent = mutableMapOf<String, Long>()
    @Synchronized fun accept(code: String, nowMillis: Long): Boolean {
        recent.entries.removeAll { nowMillis - it.value >= windowMillis || nowMillis < it.value }
        val previous = recent[code]
        if (previous != null && nowMillis - previous < windowMillis) return false
        recent[code] = nowMillis
        return true
    }
}

/** Shared input bus for the vendor broadcast, a focused wedge field, and camera decoder. */
class BarcodeInputs(
    private val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    private val deduplicator: ScanDeduplicator = ScanDeduplicator(),
    private val wedge: WedgeBuffer = WedgeBuffer(),
) : BarcodeSource {
    private val events = MutableSharedFlow<ScanEvent>(extraBufferCapacity = 32, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    override val scans = events.asSharedFlow()

    @Synchronized fun submit(code: String, source: ScanSource): ScanEvent? {
        // Vendor suffixes may contain CR/LF. Do not trim barcode spaces or otherwise normalize identifiers.
        val value = code.trimEnd('\r', '\n')
        if (value.isEmpty() || value.length > 4096) return null
        val now = clock()
        if (!deduplicator.accept(value, now)) return null
        val event = ScanEvent(value, source, now)
        events.tryEmit(event)
        return event
    }
    @Synchronized fun wedgeCharacter(character: Char, eventTimeMillis: Long): ScanEvent? =
        wedge.accept(character, eventTimeMillis)?.let { submit(it, ScanSource.WEDGE) }
    @Synchronized fun resetWedge() = wedge.reset()
    fun cameraCode(code: String): ScanEvent? = submit(code, ScanSource.CAMERA)
}
