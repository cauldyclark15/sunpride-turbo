package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.CallSheet
import org.json.JSONObject

/** Thrown for a form the person must fix; the message is fixed copy safe to show. */
class ActivityFormError(message: String) : IllegalArgumentException(message)

/**
 * AND-013 structured activity forms → exact v1 `visit.activity` wire shapes (mirrors
 * `mobile/http_handlers.ts`). Product forms only accept products on the account's call sheet,
 * because the field phone has no nationwide catalog.
 */
object ActivityForms {
    val DISPLAY = listOf("compliant" to "Compliant", "needs_action" to "Needs action", "not_present" to "Not on shelf")
    val PROMOTION = listOf("executed" to "Executed", "not_executed" to "Not executed", "not_applicable" to "Not applicable")
    val STOCK = listOf("present" to "In stock", "absent" to "Out of stock", "unknown" to "Not checked")
    private const val MAX_QUANTITY = 1_000_000_000L
    private val PRICE = Regex("^\\d{1,9}(\\.\\d{1,2})?$")
    private val WHOLE = Regex("^\\d{1,10}$")

    private fun fail(text: String): Nothing = throw ActivityFormError(text)
    private fun product(sheet: CallSheet?, productId: String?) {
        if (productId.isNullOrBlank() || sheet?.lines?.none { it.productId == productId } != false)
            fail("Choose a product from this account's call sheet")
    }

    fun merchandising(displayCondition: String?, actionTaken: String): JSONObject {
        if (displayCondition !in DISPLAY.map { it.first }) fail("Choose the display condition")
        val action = actionTaken.trim()
        if (action.length > 500) fail("Keep the action under 500 characters")
        return JSONObject().put("kind", "merchandising").put("displayCondition", displayCondition)
            .also { if (action.isNotEmpty()) it.put("actionTaken", action) }
    }

    fun promotion(programRef: String, finding: String?): JSONObject {
        val ref = programRef.trim()
        if (ref.isEmpty() || ref.length > 200) fail("Enter the promotion or program name")
        if (finding !in PROMOTION.map { it.first }) fail("Choose what you found")
        return JSONObject().put("kind", "promotion").put("programRef", ref).put("finding", finding)
    }

    fun inventoryCheck(sheet: CallSheet?, productId: String?, finding: String?, quantity: String): JSONObject {
        product(sheet, productId)
        if (finding !in STOCK.map { it.first }) fail("Choose the stock finding")
        val o = JSONObject().put("kind", "inventory_check").put("productId", productId).put("icoFinding", finding)
        val q = quantity.trim()
        if (q.isNotEmpty()) {
            val n = q.takeIf { WHOLE.matches(it) }?.toLongOrNull()?.takeIf { it <= MAX_QUANTITY }
                ?: fail("Use a whole number for the quantity")
            o.put("observedQuantity", n)
        }
        return o
    }

    /** Price in pesos (up to two decimals) → integer centavos, PHP. */
    fun priceCheck(sheet: CallSheet?, productId: String?, price: String, compliant: Boolean?): JSONObject {
        product(sheet, productId)
        val text = price.trim()
        if (!PRICE.matches(text)) fail("Enter the shelf price in pesos, e.g. 189.50")
        val (whole, fraction) = text.split('.').let { it[0] to (it.getOrNull(1) ?: "") }
        val minor = whole.toLong() * 100 + fraction.padEnd(2, '0').toLong()
        return JSONObject().put("kind", "price_check").put("productId", productId)
            .put("observedPriceMinor", minor).put("currency", "PHP")
            .also { if (compliant != null) it.put("compliant", compliant) }
    }

    /** Re-validate a queued form inside the store transaction; unknown keys or values are refused. */
    fun validate(activity: JSONObject, sheet: CallSheet?) {
        fun keys(allowed: Set<String>, required: Set<String>) {
            val present = activity.keys().asSequence().toSet()
            require(present.containsAll(required) && allowed.containsAll(present)) { "Invalid activity" }
        }
        fun text(key: String) = activity.get(key) as? String ?: throw IllegalArgumentException("Invalid $key")
        when (activity.optString("kind")) {
            "merchandising" -> {
                keys(setOf("kind", "displayCondition", "actionTaken"), setOf("kind", "displayCondition"))
                merchandising(text("displayCondition"), if (activity.has("actionTaken")) text("actionTaken") else "")
                    .also { require(!activity.has("actionTaken") || text("actionTaken").isNotBlank()) }
            }
            "promotion" -> {
                keys(setOf("kind", "programRef", "finding"), setOf("kind", "programRef", "finding"))
                promotion(text("programRef"), text("finding"))
            }
            "inventory_check" -> {
                keys(setOf("kind", "productId", "icoFinding", "observedQuantity"), setOf("kind", "productId", "icoFinding"))
                val q = if (activity.has("observedQuantity")) {
                    val n = activity.get("observedQuantity")
                    require(n is Int || n is Long) { "Invalid quantity" }
                    (n as Number).toLong().also { require(it in 0..MAX_QUANTITY) }.toString()
                } else ""
                inventoryCheck(sheet, text("productId"), text("icoFinding"), q)
            }
            "price_check" -> {
                keys(setOf("kind", "productId", "observedPriceMinor", "currency", "compliant"),
                    setOf("kind", "productId", "observedPriceMinor", "currency"))
                val n = activity.get("observedPriceMinor")
                require((n is Int || n is Long) && (n as Number).toLong() >= 0 && text("currency") == "PHP")
                if (activity.has("compliant")) require(activity.get("compliant") is Boolean)
                product(sheet, text("productId"))
            }
            else -> throw IllegalArgumentException("Unsupported activity form")
        }
    }
}
