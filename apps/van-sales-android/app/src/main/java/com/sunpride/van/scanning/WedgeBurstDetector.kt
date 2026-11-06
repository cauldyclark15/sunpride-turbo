package com.sunpride.van.scanning

/**
 * IP-HH1: finds keyboard-wedge scans among key presses at the Activity level, so a scan never lands in a text field.
 *
 * A scan is a run of printable keys where each key follows the last within [gapMillis] (a hand cannot type that fast),
 * ended by Enter or by [gapMillis] of silence. A run shorter than [minLength] or with a slow gap is typing, not a scan.
 * Pure Kotlin: the caller feeds characters with their event time and calls [idleFlush] when the gap has passed.
 */
class WedgeBurstDetector(val gapMillis: Long = 50, val minLength: Int = 4, val maxLength: Int = 256) {
    init { require(gapMillis > 0 && minLength > 0 && maxLength >= minLength) }
    private val buffer = StringBuilder()
    private var lastAt = 0L
    private var overflow = false

    val hasPending: Boolean @Synchronized get() = buffer.isNotEmpty()

    /** One printable character or '\n' (Enter). Returns the finished code when Enter ends a real burst. */
    @Synchronized fun accept(character: Char, nowMillis: Long): String? {
        if (buffer.isNotEmpty() && (nowMillis < lastAt || nowMillis - lastAt > gapMillis)) reset()
        if (character == '\n' || character == '\r') return finish()
        if (character.isISOControl()) return null
        lastAt = nowMillis
        if (overflow) return null
        if (buffer.length >= maxLength) { overflow = true; buffer.clear(); return null }
        buffer.append(character)
        return null
    }

    /** Silence for [gapMillis] ends a burst without Enter (the Senraise wedge sends none). */
    @Synchronized fun idleFlush(nowMillis: Long): String? =
        if ((buffer.isNotEmpty() || overflow) && nowMillis - lastAt >= gapMillis) finish() else null

    @Synchronized fun reset() { buffer.clear(); overflow = false; lastAt = 0L }

    private fun finish(): String? {
        val code = if (overflow || buffer.length < minLength) null else buffer.toString()
        reset()
        return code
    }
}

/**
 * Pure router between [WedgeBurstDetector] and the shared [BarcodeInputs] gate (one 300 ms duplicate filter for the
 * broadcast, the wedge and the camera). [onCharacter] returns true when the key was taken as part of a possible scan.
 */
class WedgeRouter(private val inputs: BarcodeInputs, private val detector: WedgeBurstDetector = WedgeBurstDetector()) {
    val hasPending: Boolean get() = detector.hasPending
    val gapMillis: Long get() = detector.gapMillis
    fun onCharacter(character: Char, nowMillis: Long): Boolean {
        val enter = character == '\n' || character == '\r'
        // A lone Enter (nothing buffered) is a normal key press: let the screen have it.
        if (enter && !detector.hasPending) return false
        detector.accept(character, nowMillis)?.let { inputs.submit(it, ScanSource.WEDGE) }
        return true
    }
    fun onIdle(nowMillis: Long) { detector.idleFlush(nowMillis)?.let { inputs.submit(it, ScanSource.WEDGE) } }
    fun reset() = detector.reset()
}
