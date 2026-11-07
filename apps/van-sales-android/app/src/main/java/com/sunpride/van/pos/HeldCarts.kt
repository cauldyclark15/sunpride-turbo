package com.sunpride.van.pos

import org.json.JSONArray
import org.json.JSONObject

/** One line of a parked cart: what was in it and the price the cashier saw (to say so if it changed). */
data class HeldLine(val productId: String, val name: String, val quantityBase: Long, val unitPriceMinor: Long?)

/** A cart parked on this phone. [surface] is `store` or `van`; a van cart remembers its customer. */
data class HeldCart(val holdId: String, val surface: String, val name: String, val note: String?, val customerId: String?, val customerName: String?,
    val lines: List<HeldLine>, val totalLabel: String, val createdAt: Long)

/** What a recall brings back: the lines that still sell, and one plain sentence per change. */
data class RecalledCart(val lines: List<CartLine>, val notes: List<String>)

/**
 * IP-HOLD: parking a cart and getting it back. Held carts live on the phone only (Room); they hold no stock and no price, so on
 * recall every line is checked against the products, stock and prices the phone has NOW and anything that changed is said in words.
 */
object HeldCartRules {
    const val MAX_HELD = 20
    const val MAX_LINES = 200
    const val SURFACE_STORE = "store"
    const val SURFACE_VAN = "van"

    /** Why this cart cannot be held right now, or null. */
    fun problemHolding(lines: List<*>, alreadyHeld: Int): String? = when {
        lines.isEmpty() -> "Add something to the cart first."
        lines.size > MAX_LINES -> "This cart has too many items to hold."
        alreadyHeld >= MAX_HELD -> "You already have $MAX_HELD held carts. Recall or discard one first."
        else -> null
    }

    /** The name shown on the list: what the cashier typed, else "Cart 3" (counting the carts already held). */
    fun displayName(typed: String?, alreadyHeld: Int): String = typed?.trim()?.takeIf { it.isNotEmpty() }?.take(40) ?: "Cart ${alreadyHeld + 1}"
    fun cleanNote(note: String?): String? = note?.trim()?.takeIf { it.isNotEmpty() }?.take(200)?.filterNot { it.isISOControl() }?.takeIf { it.isNotEmpty() }

    fun encode(lines: List<HeldLine>): String = JSONArray(lines.map {
        JSONObject().put("productId", it.productId).put("name", it.name).put("quantityBase", it.quantityBase.toString())
            .put("unitPriceMinor", it.unitPriceMinor?.toString() ?: JSONObject.NULL)
    }).toString()

    fun decode(json: String): List<HeldLine> = JSONArray(json).let { a ->
        (0 until a.length()).map { a.getJSONObject(it) }.map {
            HeldLine(it.getString("productId"), it.getString("name"), it.getString("quantityBase").toLong(), if (it.isNull("unitPriceMinor")) null else it.getString("unitPriceMinor").toLong())
        }
    }

    /**
     * Re-checks a held cart. [stockBase] is the sellable stock now (null = the product is not on this phone any more), [priceNow] the unit price now
     * (null = no price), [money] formats a price. A line with nothing left to sell is dropped; one with less than before is cut down.
     */
    fun recall(cart: HeldCart, stockBase: (String) -> Long?, nameOf: (String) -> String?, priceNow: (String) -> Long?, money: (Long) -> String, enforceStock: Boolean = true): RecalledCart {
        val kept = ArrayList<CartLine>()
        val notes = ArrayList<String>()
        for (l in cart.lines) {
            val name = nameOf(l.productId) ?: l.name
            val stock = stockBase(l.productId)
            if (nameOf(l.productId) == null || stock == null) { notes.add("$name is not sold here any more, so it was left out."); continue }
            var qty = l.quantityBase
            if (enforceStock) {
                if (stock <= 0L) { notes.add("$name is out of stock, so it was left out."); continue }
                if (qty > stock) { notes.add("$name: only $stock left now (you held $qty)."); qty = stock }
            }
            val now = priceNow(l.productId)
            if (now != null && l.unitPriceMinor != null && now != l.unitPriceMinor) notes.add("$name: the price is now ${money(now)} (it was ${money(l.unitPriceMinor)}).")
            kept.add(CartLine(l.productId, qty))
        }
        return RecalledCart(kept, notes)
    }

    /** What stops the till (or the trip) closing while carts are still parked, in plain words; null when none are. */
    fun closeBlock(count: Int, what: String = "close the till"): String? =
        if (count <= 0) null else "You have $count held ${if (count == 1) "cart" else "carts"}. Recall and finish ${if (count == 1) "it" else "them"}, or discard ${if (count == 1) "it" else "them"}, before you $what."
}

/** Closing was refused only because carts are still parked; the message is already the words to show. */
class HeldCartsBlock(message: String) : IllegalStateException(message)
