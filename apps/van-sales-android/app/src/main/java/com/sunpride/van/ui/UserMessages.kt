package com.sunpride.van.ui

import com.sunpride.van.auth.AuthFailure
import com.sunpride.van.auth.NativeApiFailure
import com.sunpride.van.sync.VanSyncFailure

/**
 * IP-P0 (SPEC 8.4 / 0.5): the one place that turns a server error code or a known exception text into a plain
 * sentence for the seller or cashier. Anything not in the tables is replaced by the caller's fallback, so raw server
 * text, codes, URLs and exception class names never reach a screen.
 */
object UserMessages {
    const val DEFAULT = "Could not save this change. Check the details and try again."
    const val NOT_SET_UP = "This handheld is not set up for you. Ask your supervisor to hand it over."
    const val STALE_COUNT = "Stock moved on this line while you counted. It will be rechecked automatically."
    const val TOO_MANY_LOTS = "Too many batches on one line. Split this line in two."
    const val CASE_SIZE_MISSING = "Case size not set for this product. Enter pieces."
    const val SETTINGS_CHANGED = "Settings changed in the office. Tap Sync."
    const val LOAD_DIFFERENCE_SENT = "Load difference sent to your supervisor. You will be told here when it is decided."

    /** Server `code` values (machine codes stay in the body; the screen shows the sentence). */
    private val byCode: Map<String,String> = mapOf(
        "stale_snapshot" to STALE_COUNT,
        "too_many_lots" to TOO_MANY_LOTS,
        "lot_limit" to TOO_MANY_LOTS,
        "unit_setup_needed" to CASE_SIZE_MISSING,
        "base" to CASE_SIZE_MISSING,
        "config_outdated" to SETTINGS_CHANGED,
        "register_config_changed" to SETTINGS_CHANGED,
        "load_pending_approval" to LOAD_DIFFERENCE_SENT,
        "awaiting_approval" to LOAD_DIFFERENCE_SENT,
        "device_not_set_up_for_you" to NOT_SET_UP,
        "device_revoked" to NOT_SET_UP,
        "device_removed" to NOT_SET_UP,
        "device_handover_required" to "Another phone is active for your account. Ask the office to start a controlled handover.",
        "device_integrity_blocked" to "This phone needs an integrity review before it can record work.",
        "device_integrity_required" to "Refresh this phone online before recording work. Update the app if the integrity check is unavailable.",
        "device_unavailable" to "This phone isn't available for your account. Ask your administrator.",
        "scope_withdrawn" to "Your assignment changed. Ask your administrator to re-register this phone.",
        "device_suspended" to "This phone is paused. Ask your administrator.",
        "device_unbound" to "This phone isn't registered yet. Ask your administrator.",
        "not_registered" to "This phone isn't registered yet. Ask your administrator.",
        "already_bound" to "This phone is registered to a different account. Ask your administrator.",
        "credential_taken" to "This phone is registered to a different account. Ask your administrator.",
        "rate_limited" to "Too many attempts. Wait a minute and try again.",
        "unauthorized" to "The office did not accept this phone's work. Your work is kept here. Ask your supervisor.",
        "version_unsupported" to "This app needs an update. Your work is kept here.",
        "temporarily_unavailable" to "Could not reach the office. Your work is kept here. Try again.",
        "opening_float_invalid" to "The opening float must be between ₱0 and ₱100,000.",
    )
    /** Known exception / old server texts, matched case-insensitively as a fragment. First match wins. */
    private val byText: List<Pair<String,String>> = listOf(
        "stale_snapshot" to STALE_COUNT,
        "start a new count" to STALE_COUNT,
        "more than 50 lots" to TOO_MANY_LOTS,
        "split the document" to TOO_MANY_LOTS,
        "unit setup needed" to CASE_SIZE_MISSING,
        "download the register's current configuration" to SETTINGS_CHANGED,
        "waiting for supervisor approval" to LOAD_DIFFERENCE_SENT,
        "phone removed" to NOT_SET_UP,
        "open a cashier session first" to "Open a cashier session first.",
        "this register needs a current office authorization" to SETTINGS_CHANGED,
        "a cashier session is already open" to "A cashier session is already open on this handheld.",
        "this register has already closed its sales day" to "This register has already closed its sales day. Ask your supervisor.",
        "confirm printer paper first" to "Check that the printer has paper, then try again.",
    )

    /** "Load difference sent to Juan Dela Cruz. ..." when the supervisor's name is known. */
    fun loadDifferenceSent(supervisorName: String?): String =
        if (supervisorName.isNullOrBlank()) LOAD_DIFFERENCE_SENT else LOAD_DIFFERENCE_SENT.replace("your supervisor", supervisorName.trim())

    fun forCode(code: String?): String? = code?.let { byCode[it] }
    fun forText(text: String?): String? {
        val t = text?.lowercase() ?: return null
        return byText.firstOrNull { (fragment,_) -> t.contains(fragment) }?.second
    }
    /** True when the sentence is the "not set up for you" one, which comes with a Call button. */
    fun needsCall(message: String?): Boolean = message == NOT_SET_UP

    /**
     * The sentence for a failure. Codes and known texts map; a short plain sentence thrown by this app's own checks
     * (IllegalState/IllegalArgument with no URL, class name or brace) passes only when [passLocal]; the rest is [fallback].
     */
    fun forFailure(e: Throwable, fallback: String = DEFAULT, passLocal: Boolean = false): String {
        when (e) {
            is AuthFailure -> return e.kind.message
            is NativeApiFailure -> return forCode(e.code) ?: "Couldn't verify this phone. Try again."
            is VanSyncFailure -> return forCode(e.code) ?: "The office could not take this work yet. Your work is kept here. Try again."
        }
        forText(e.message)?.let { return it }
        if (passLocal && (e is IllegalStateException || e is IllegalArgumentException || e.javaClass.simpleName == "CallFlowRefused")) {
            e.message?.takeIf { isPlainSentence(it) }?.let { return it }
        }
        return fallback
    }
    internal fun isPlainSentence(text: String): Boolean =
        text.length in 3..160 && text.none { it.isISOControl() || it == '{' || it == '}' || it == '<' || it == '>' } &&
            !text.contains("http",true) && !text.contains("exception",true) && !text.contains("Error:",true) &&
            !Regex("[0-9a-f]{8}-[0-9a-f]{4}-").containsMatchIn(text.lowercase()) && !Regex("\\b[a-z]+(_[a-z]+)+\\b").containsMatchIn(text)
}
