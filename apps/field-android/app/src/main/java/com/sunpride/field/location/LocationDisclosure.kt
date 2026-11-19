package com.sunpride.field.location

/** What tapping Start day does next. */
enum class LocationStep { DISCLOSURE, SYSTEM_PROMPT, START }

/**
 * SP-0207 (Google Play prominent disclosure): Android's location prompt is never shown before this person
 * agreed to the in-app disclosure (what, why, who sees it, when it stops). Pure, unit-tested.
 */
object LocationDisclosureGate {
    fun onStart(consented: Boolean, locationAllowed: Boolean): LocationStep = when {
        !consented -> LocationStep.DISCLOSURE
        !locationAllowed -> LocationStep.SYSTEM_PROMPT
        else -> LocationStep.START
    }
}
