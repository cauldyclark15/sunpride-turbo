package com.sunpride.field.ui.diagnosticvisit

import com.sunpride.field.storage.CallSheet
import org.json.JSONArray
import org.json.JSONObject

/** Text drafts keep blanks distinct from zero and reject pasted decimals/signs instead of truncating. */
data class CallSheetDraftLine(val productId: String, val order: String = "", val beginningInventory: String = "",
    val take: String = "", val delivered: String = "", val offtake: String = "", val endInventory: String = "") {
    fun values(): List<String> = listOf(order, beginningInventory, take, delivered, offtake, endInventory)
}

object CallSheetPayload {
    val measures = listOf("order", "beginningInventory", "take", "delivered", "offtake", "endInventory")
    val labels = listOf("Order", "Beginning inv.", "Take", "Delivered", "Off-take", "End inv.")
    fun quantity(text: String): Int? {
        val value = text.trim()
        if (value.isEmpty()) return null
        require(value.all { it in '0'..'9' }) { "Use whole numbers from 0 to 1,000,000" }
        return value.toIntOrNull()?.also { require(it in 0..1_000_000) }
            ?: throw IllegalArgumentException("Use whole numbers from 0 to 1,000,000")
    }
    fun activity(sheet: CallSheet, drafts: List<CallSheetDraftLine>): JSONObject {
        require(drafts.map { it.productId }.distinct().size == drafts.size)
        val allowed = sheet.lines.map { it.productId }.toSet()
        val lines = JSONArray()
        drafts.forEach { draft ->
            require(draft.productId in allowed) { "Product is not on this account's call sheet" }
            val values = draft.values().map { quantity(it) }
            if (values.any { it != null }) lines.put(JSONObject().put("productId", draft.productId).apply {
                measures.zip(values).forEach { (key, value) -> put(key, value ?: JSONObject.NULL) }
            })
        }
        require(lines.length() in 1..100) { "Enter at least one quantity" }
        return JSONObject().put("kind", "call_sheet").put("lines", lines).also { validate(it, sheet) }
    }
    /** Repeat at the transactional store boundary; do not trust a UI-selected outlet or product. */
    fun validate(activity: JSONObject, sheet: CallSheet) {
        require(activity.getString("kind") == "call_sheet")
        require(activity.keys().asSequence().toSet() == setOf("kind", "lines"))
        val lines = activity.getJSONArray("lines")
        require(lines.length() in 1..100)
        val allowed = sheet.lines.map { it.productId }.toSet()
        val seen = mutableSetOf<String>()
        for (i in 0 until lines.length()) {
            val line = lines.getJSONObject(i)
            require(line.keys().asSequence().toSet() == measures.toSet() + "productId")
            val id = line.get("productId")
            require(id is String && id in allowed && seen.add(id))
            var touched = false
            measures.forEach { key ->
                val value = line.get(key)
                if (value != JSONObject.NULL) {
                    require(value is Int || value is Long)
                    require((value as Number).toLong() in 0..1_000_000)
                    touched = true
                }
            }
            require(touched)
        }
    }
}
