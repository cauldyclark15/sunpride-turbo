package com.sunpride.field.ui.diagnosticvisit

import java.math.BigDecimal
import java.util.concurrent.ConcurrentHashMap

/** FLD-102: what the person typed in one retail-execution form. Survives a trip to the photo screen. */
data class RetailDraft(
    val selected: Int = 0, val first: String = "", val second: String = "", val third: String = "", val fourth: String = "",
    val note: String = "", val none: Boolean = false, val condition: String = "good", val type: String = "price",
    val passed: Set<String> = emptySet(), val facings: List<String> = emptyList(), val positions: List<String> = emptyList(),
)

/**
 * FLD-102: typed retail fields and the chosen kind, per open call, kept in memory while the app runs. Leaving the
 * visit screen (Take photo, an activity form) disposes the composable; its draft stays here until Save succeeds.
 */
object RetailDrafts {
    private val drafts = ConcurrentHashMap<String, RetailDraft>()
    private val kinds = ConcurrentHashMap<String, String>()
    fun kind(call: String): String = kinds[call] ?: "freezer"
    fun setKind(call: String, kind: String) { kinds[call] = kind }
    fun get(call: String, kind: String): RetailDraft = drafts["$call|$kind"] ?: RetailDraft()
    fun put(call: String, kind: String, draft: RetailDraft) { drafts["$call|$kind"] = draft }
    fun clear(call: String, kind: String) { drafts.remove("$call|$kind") }
    /** Test/sign-out seam. */
    fun reset() { drafts.clear(); kinds.clear() }
}

/** FLD-102: the help line and the missing-field message for each retail-execution kind. */
object RetailFormCheck {
    fun help(kind: String): String = when (kind) {
        "freezer" -> "Scan or enter the equipment serial. Record the measured temperature, not a guessed value."
        "expiry" -> "One SKU and shelf batch per saved audit. Repeat for each batch."
        "planogram" -> "Compare what is actually on the shelf with the downloaded target."
        "posm" -> "Check each display material placed at this store: is it there, and in what condition?"
        "promotion" -> "Check the running campaign at this store. Tick each check that passes."
        "competitor" -> "Record what competitors are doing at this store, or that you saw nothing."
        "issue_log" -> "Log a problem at this store (damaged stock, pests, a complaint), or that there was none."
        else -> ""
    }
    private fun whole(v: String) = v.trim().toLongOrNull() != null
    private fun decimal(v: String) = runCatching { BigDecimal(v.trim()) }.isSuccess
    private fun date(v: String) = runCatching { java.time.LocalDate.parse(v.trim()) }.isSuccess

    /**
     * The FIRST field that stops Save, named as on screen; null when the form is complete.
     * [choice] is the label of the setup list to pick from (null when the kind has none); [products] names the
     * planogram target lines.
     */
    fun missing(kind: String, d: RetailDraft, choice: String?, hasChoices: Boolean, products: List<String> = emptyList()): String? {
        if (choice != null && !hasChoices) return "No $choice is available in this offline snapshot. Sync or ask the office."
        return when (kind) {
            "freezer" -> when {
                d.first.isBlank() -> "Enter the Scanned serial, or scan the equipment label."
                !decimal(d.second) -> "Enter the Temperature °C as a number, for example -18.5."
                !whole(d.third) -> "Enter the Own-product share % as a whole number from 0 to 100."
                else -> null
            }
            "expiry" -> when {
                d.first.isBlank() -> "Enter the Batch number."
                !date(d.second) -> "Enter the Expiry date as YYYY-MM-DD."
                !whole(d.third) -> "Enter the Shelf quantity in whole pieces."
                else -> null
            }
            "planogram" -> products.indices.firstNotNullOfOrNull { i ->
                when {
                    !whole(d.facings.getOrElse(i) { "" }) -> "Enter Actual facings for ${products[i]}."
                    d.positions.getOrElse(i) { "" }.isBlank() -> "Enter Actual position for ${products[i]}."
                    else -> null
                }
            } ?: if (!whole(d.first)) "Enter Total shelf facings · all brands." else null
            "competitor" -> if (d.none) null else when {
                d.first.isBlank() -> "Enter the Brand."
                d.second.isBlank() -> "Enter the Competitor SKU."
                d.type == "price" && !decimal(d.third) -> "Enter the Observed price in pesos."
                d.type == "shelf_share" && !whole(d.third) -> "Enter the Share of shelf % as a whole number."
                d.type in setOf("promotion", "display") && d.fourth.isBlank() -> "Enter the Display or promotion detail."
                d.note.isBlank() -> "Enter the Observation."
                else -> null
            }
            "issue_log" -> if (!d.none && d.note.isBlank()) "Enter the Incident details, or tick No incident observed." else null
            else -> null
        }
    }
}
