package com.sunpride.van.pos

import org.json.JSONObject

/**
 * NF-5: the trip's cash the office already holds, per sale (`trip.serverCash` in the handheld bundle). A seller who
 * signs in on another phone mid-trip does not have the earlier phone's sales; their cash still goes in the bag, so
 * the expected cash adds the office's rows for every sale this phone does not hold. Without it the phone expected
 * less than the office and the count was refused at upload ("Expected cash changed").
 */
object ServerTripCash {
    const val FIELD = "serverCash"
    data class Entry(val saleId: String, val kind: String, val amountMinor: Long)
    /** What the other phone(s) add: [sales] cash sales (voided ones excluded) and their net cash. */
    data class OtherPhones(val sales: Int, val netMinor: Long)

    /** Null when the bundle has no list (older server, or too many rows): the phone then counts only its own sales. */
    fun decode(trip: JSONObject?): List<Entry>? {
        val a = trip?.optJSONArray(FIELD) ?: return null
        return (0 until a.length()).map { i -> a.getJSONObject(i).let {
            Entry(it.getString("saleId"), it.getString("kind").also { k -> require(k in KINDS) },
                it.getString("amountMinor").toLong().also { m -> require(m >= 0) })
        } }
    }
    private val KINDS = setOf("sale", "void_refund", "refund")

    /** Rows for sales this phone does not hold: sales add, voids and refunds take away. */
    fun otherPhones(entries: List<Entry>?, localSaleIds: Set<String>): OtherPhones {
        val foreign = entries.orEmpty().filter { it.saleId !in localSaleIds }
        val voided = foreign.filter { it.kind == "void_refund" }.map { it.saleId }.toSet()
        val net = foreign.fold(0L) { t, e -> if (e.kind == "sale") Math.addExact(t, e.amountMinor) else Math.subtractExact(t, e.amountMinor) }
        return OtherPhones(foreign.filter { it.kind == "sale" && it.saleId !in voided }.map { it.saleId }.distinct().size, net)
    }
}
