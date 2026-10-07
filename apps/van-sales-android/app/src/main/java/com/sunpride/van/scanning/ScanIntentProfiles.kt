package com.sunpride.van.scanning

/**
 * VAN-009 supported hardware-scanner broadcast intents. Each vendor scan service sends the decoded
 * text as a broadcast extra; the app listens (only while a scan screen is visible) for these actions.
 *
 * Only the Senraise H10P profile is verified on a real device. The others are the vendors'
 * documented factory defaults, so the same app works if Sunpride's fleet includes them; a scanner
 * that can be configured (Zebra DataWedge, Honeywell, generic "broadcast" mode) should send the
 * Sunpride action [SUNPRIDE_ACTION] with the barcode in [SUNPRIDE_EXTRA]. See docs/PRINTER_AND_SCANNER.md.
 *
 * Broadcast content is untrusted product lookup input, never authorization or a sale command.
 */
data class ScanIntentProfile(val vendor: String, val action: String, val stringExtras: List<String>,
    val byteExtras: List<String> = emptyList(), val lengthExtra: String? = null, val verifiedOnDevice: Boolean = false)

object ScanIntentProfiles {
    const val SUNPRIDE_ACTION = "com.sunpride.van.SCAN"
    const val SUNPRIDE_EXTRA = "barcode"

    val SUPPORTED: List<ScanIntentProfile> = listOf(
        ScanIntentProfile("Senraise H10P", "android.scanner.scan", listOf("result"), verifiedOnDevice = true),
        ScanIntentProfile("Senraise / Urovo (legacy firmware)", "scan.rcv.message", listOf("barcode_string"),
            byteExtras = listOf("barocode"), lengthExtra = "length"),
        ScanIntentProfile("Urovo", "android.intent.ACTION_DECODE_DATA", listOf("barcode_string"),
            byteExtras = listOf("barocode"), lengthExtra = "length"),
        ScanIntentProfile("Sunmi", "com.sunmi.scanner.ACTION_DATA_CODE_RECEIVED", listOf("data")),
        ScanIntentProfile("Newland", "nlscan.action.SCANNER_RESULT", listOf("SCAN_BARCODE1")),
        ScanIntentProfile("iData / Kaicom", "android.intent.action.SCANRESULT", listOf("value")),
        ScanIntentProfile("Configured (Zebra DataWedge, Honeywell, generic)", SUNPRIDE_ACTION,
            listOf(SUNPRIDE_EXTRA, "com.symbol.datawedge.data_string", "data")),
    )

    val actions: List<String> get() = SUPPORTED.map { it.action }.distinct()

    /**
     * The scanned text carried by a broadcast, or null when the action is unknown or carries no code.
     * [extra] reads one Intent extra (String or ByteArray); a wrong type returns null, never throws.
     */
    fun extract(action: String?, extra: (String) -> Any?): String? {
        val profile = SUPPORTED.firstOrNull { it.action == action } ?: return null
        profile.stringExtras.forEach { key -> (safe(extra, key) as? String)?.takeIf { it.isNotEmpty() }?.let { return it } }
        profile.byteExtras.forEach { key ->
            val bytes = safe(extra, key) as? ByteArray ?: return@forEach
            val declared = profile.lengthExtra?.let { safe(extra, it) as? Int }
            val length = if (declared != null && declared in 1..bytes.size) declared else bytes.size
            val text = String(bytes, 0, length, Charsets.UTF_8).trimEnd('\u0000')
            if (text.isNotEmpty()) return text
        }
        return null
    }

    private fun safe(extra: (String) -> Any?, key: String): Any? = runCatching { extra(key) }.getOrNull()
}
