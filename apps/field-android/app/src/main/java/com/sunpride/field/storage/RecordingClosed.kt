package com.sunpride.field.storage

/**
 * FLD-146: the phone's recording window is shut (day closed at the offline-lease end, or the partition is held).
 * Its message is the REAL reason a Start/End/photo was refused; never the generic "check required fields".
 */
class RecordingClosed(val held: Boolean) : IllegalStateException(if (held) HELD else DAY_CLOSED) {
    companion object {
        const val DAY_CLOSED = "Day closed: this phone stopped taking new calls at the 10 PM day close. " +
            "Tap Sync now when you have signal; if Start is still refused, ask the office."
        const val HELD = "This phone's records are held for office review. Ask the office, then sync."
    }
}

/** The visit screen's message for a Start/End/activity the phone could not queue. */
object QueueFailureText {
    const val GENERIC = "Could not queue visit. Sync for access and check required fields."
    fun of(e: Throwable): String = generateSequence(e) { it.cause }.firstNotNullOfOrNull {
        when (it) {
            is RecordingClosed -> it.message
            is RetailChecklistUnsaved -> it.message
            else -> null
        }
    } ?: GENERIC
}

/** The camera screen's message for a photo the phone could not keep. */
object PhotoFailureText {
    const val GENERIC = "Could not save this photo. Try again."
    fun of(e: Throwable): String = generateSequence(e) { it.cause }.firstNotNullOfOrNull {
        when (it) {
            is com.sunpride.integrity.EvidenceLocationUnavailable -> it.message
            is RecordingClosed -> it.message
            else -> null
        }
    } ?: GENERIC
}
