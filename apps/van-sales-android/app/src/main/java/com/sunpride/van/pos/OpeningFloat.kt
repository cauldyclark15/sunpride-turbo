package com.sunpride.van.pos

/**
 * IP-P0 (SPEC 6.7): the opening float entered at trip start, in whole pesos on a big keypad.
 * Wire: `openingFloatCentavos`, an integer 0..10_000_000, in the `trip.start` operation payload.
 */
object OpeningFloat {
    /** What a usual float is; shown as a hint, never prefilled, so the seller always types the real amount. */
    const val HINT_PESOS = 2_000L
    const val MAX_CENTAVOS = 10_000_000L
    const val FIELD = "openingFloatCentavos"
    /** The same ceiling the office enforces on a trip float and on a store opening float. */
    const val CAP_MESSAGE = "Opening float must be between ₱0 and ₱100,000"
    private const val MAX_PESOS = MAX_CENTAVOS / 100

    /** One key press on the pad: a digit, "00" or "back". A press that would pass the maximum is ignored. */
    fun press(current: String, key: String): String {
        if (key == "back") return current.dropLast(1)
        if (key != "00" && !(key.length == 1 && key[0].isDigit())) return current
        val next = (current + key).trimStart('0')
        if (next.length > 7 || (next.isNotEmpty() && next.toLong() > MAX_PESOS)) return current
        return next
    }
    /** Centavos for the typed pesos, or null while nothing is typed (a deliberate 0 is typed as "0"). */
    fun centavos(typed: String): Long? = typed.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toLong()?.let { Math.multiplyExact(it, 100L) }
        ?.takeIf { it in 0..MAX_CENTAVOS }
    /** "₱2,000" for display; empty input reads as "₱0". */
    fun display(typed: String): String = "₱" + String.format(java.util.Locale.US, "%,d", typed.toLongOrNull() ?: 0L)
    /**
     * Which float expected cash starts from. Once the office's bundle shows the trip started, its float is the truth
     * (a replaced phone or cleared data has no saved start); until then the start saved on this phone is.
     */
    fun resolve(bundleFloat: Long?, bundleStarted: Boolean, savedStartFloat: Long?): Long =
        (if (bundleStarted && bundleFloat != null) bundleFloat else savedStartFloat ?: bundleFloat)?.takeIf { it in 0..MAX_CENTAVOS } ?: 0L
    fun valid(centavos: Long?): Boolean = centavos != null && centavos in 0..MAX_CENTAVOS
}
