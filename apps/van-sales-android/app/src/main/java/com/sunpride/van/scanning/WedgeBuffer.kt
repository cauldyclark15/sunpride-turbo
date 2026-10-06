package com.sunpride.van.scanning

/** Pure Kotlin keyboard-wedge buffer. Capture printable key-down characters in a focused field.
 * Enter/CR completes a scan; a stale partial burst is discarded after [timeoutMillis].
 * Oversized bursts are rejected entirely (not emitted as a truncated valid-looking code).
 */
class WedgeBuffer(private val timeoutMillis: Long = 250, private val maxLength: Int = 4096) {
    init { require(timeoutMillis > 0); require(maxLength > 0) }
    private val buffer = StringBuilder()
    private var lastAt: Long? = null
    private var overflow = false

    @Synchronized fun accept(character: Char, nowMillis: Long): String? {
        lastAt?.let { if (nowMillis < it || nowMillis - it > timeoutMillis) reset() }
        lastAt = nowMillis
        if (character == '\n' || character == '\r') {
            val code = if (overflow) null else buffer.toString().takeIf { it.isNotEmpty() }
            reset()
            return code
        }
        if (character == '\b') {
            if (buffer.isNotEmpty()) buffer.deleteCharAt(buffer.lastIndex)
        } else if (!character.isISOControl() && !overflow) {
            if (buffer.length >= maxLength) { overflow = true; buffer.clear() }
            else buffer.append(character)
        }
        return null
    }
    @Synchronized fun reset() { buffer.clear(); lastAt = null; overflow = false }
}
