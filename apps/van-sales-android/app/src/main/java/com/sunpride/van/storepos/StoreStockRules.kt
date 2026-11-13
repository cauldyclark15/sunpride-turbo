package com.sunpride.van.storepos

import org.json.JSONObject

/** POS-042/POS-043: the store Stock screen's checks and the count line it sends, kept out of Compose for tests. */
object StoreStockRules {
    const val EXPIRY_PROBLEM = "Type the expiry date as YYYY-MM-DD, for example 2026-12-31."
    const val QUANTITY_PROBLEM = "Type the quantity as a whole number, for example 12."

    fun expiryOk(text: String): Boolean = text.isBlank() || runCatching { java.time.LocalDate.parse(text.trim()) }.isSuccess
    fun quantity(text: String): Long? = text.trim().takeIf { Regex("[0-9]{1,12}").matches(it) }?.toLong()?.takeIf { it > 0 }

    /** The first thing that stops Save receiving, in plain words (null = ready). Shown next to the button. */
    fun receiveProblem(po: String, product: String, amount: String, expiry: String, open: Boolean): String? = when {
        !open -> "Open the till (Till tab) to save stock changes."
        po.isBlank() -> "Type the purchase order reference."
        product.isBlank() -> "Choose the product."
        quantity(amount) == null -> QUANTITY_PROBLEM
        !expiryOk(expiry) -> EXPIRY_PROBLEM
        else -> null
    }

    /** Count row label: product, then batch (lot and expiry) or the stock status, so two batches never look the same. */
    fun lineLabel(product: JSONObject, line: JSONObject): String {
        val lot = line.optString("lotNumber").takeIf { !line.isNull("lotNumber") && it.isNotBlank() }
        val expiry = line.optString("expiresOn").takeIf { !line.isNull("expiresOn") && it.isNotBlank() }
        val status = line.getString("stockStatus").replace('_', ' ')
        val batch = when {
            lot != null -> "Lot $lot" + (expiry?.let { " · exp $it" } ?: "") + (if (status != "available") " · $status" else "")
            line.isNull("lotId") || line.optString("lotId").isBlank() -> status
            else -> "Batch ${line.getString("lotId").take(8)} · $status"
        }
        return "${product.getString("name")} · $batch · ${product.getString("uomCode")}"
    }

    /** One count line as the office reads it: counted quantity as a whole-number decimal string (the van wire rule). */
    fun countLine(product: JSONObject, line: JSONObject, countedBase: Long): JSONObject = JSONObject()
        .put("productId", product.getString("productId")).put("lotId", line.opt("lotId") ?: JSONObject.NULL)
        .put("stockStatus", line.getString("stockStatus")).put("version", line.getString("version"))
        .put("countedBase", countedBase.toString())

    /**
     * POS-044: "Receive all shipped" lines as the office reads them (`storepos/operations.js transferReceiveLines`):
     * `receivedGoodBase` as a whole-number decimal string, nothing damaged or on hold.
     */
    fun receiveAllShipped(shipped: org.json.JSONArray): org.json.JSONArray = org.json.JSONArray((0 until shipped.length()).map { i ->
        val line = shipped.getJSONObject(i)
        val quantity = line.getString("quantityBase").trim()
        require(Regex("0|[1-9][0-9]{0,15}").matches(quantity)) { "Shipped quantity must be a whole number" }
        JSONObject().put("lineId", line.getString("lineId")).put("receivedGoodBase", quantity)
            .put("receivedDamagedBase", "0").put("receivedHoldBase", "0")
    })
}
