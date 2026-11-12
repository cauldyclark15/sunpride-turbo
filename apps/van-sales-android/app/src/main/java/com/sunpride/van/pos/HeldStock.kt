package com.sunpride.van.pos

import com.sunpride.van.data.TruckStock
import org.json.JSONObject

/**
 * r6van4: truck stock the office will not let leave for a sale (`trip.heldStock` in the handheld bundle): batches that are
 * quarantined, recall-held, expired or too close to expiry. The goods are still on the truck (the stock screen and the stock
 * count keep them), but the phone may not sell them: the office refuses such a sale at upload ("Insufficient eligible lot
 * stock") and its printed invoice number is spoiled. Selling therefore checks [sellable], so the seller is stopped in the
 * cart with "not enough stock" instead of after the customer has paid.
 */
object HeldStock {
    const val FIELD = "heldStock"

    /** Held base quantity per product from the saved trip JSON; empty for an older server or a malformed list. */
    fun decode(tripJson: String?): Map<String, Long> = runCatching {
        val a = tripJson?.let { JSONObject(it).optJSONArray(FIELD) } ?: return emptyMap()
        (0 until a.length()).associate { i ->
            val o = a.getJSONObject(i)
            o.getString("productId") to o.getString("quantityBase").toLong().also { require(it >= 0) }
        }
    }.getOrDefault(emptyMap())

    /** What may be sold: the truck's available stock less the held part (never below zero). */
    fun sellable(stock: List<TruckStock>, held: Map<String, Long>): List<TruckStock> =
        if (held.isEmpty()) stock
        else stock.map { s -> held[s.productId]?.let { h -> s.copy(availableBase = maxOf(0L, s.availableBase - h)) } ?: s }
}
