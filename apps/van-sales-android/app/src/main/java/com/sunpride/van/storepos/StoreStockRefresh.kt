package com.sunpride.van.storepos

/**
 * IP-INT3FIX: the store sale grid shows stock from the last office download. When the office receives stock while the grid is
 * open, nothing downloaded it, so every card stayed EMPTY until the cashier left and came back. While the grid is open the phone
 * now asks the office for a quiet refresh on entry and once a minute; the screen already redraws from the stored download, so the
 * badges change as soon as it lands. It never runs while something is saving, never overlaps itself and never shows a message.
 */
object StoreStockRefresh {
    const val EVERY_MS = 60_000L
    fun due(lastAtMs: Long?, nowMs: Long, busy: Boolean, inFlight: Boolean, everyMs: Long = EVERY_MS): Boolean =
        !busy && !inFlight && (lastAtMs == null || nowMs - lastAtMs >= everyMs || nowMs < lastAtMs)
}
