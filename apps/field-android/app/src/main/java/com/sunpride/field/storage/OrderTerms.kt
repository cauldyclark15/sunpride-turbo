package com.sunpride.field.storage

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/** SP-0088 account-scoped previews. The office always re-prices the quantity-only order wire. */
data class OrderPriceList(val id: String, val code: String, val name: String, val currency: String, val sample: Boolean)
data class OrderUnit(val productId: String, val uom: String, val unitPriceMinor: Long?)
data class OrderTerms(val outletId: String, val priceList: OrderPriceList?, val lines: List<OrderUnit>)

data class AccountSales(val from: String, val to: String, val complete: Boolean, val orders: Long,
    val amountMinor: Long, val recentOrders: Long, val recentAmountMinor: Long,
    val lastOrderDate: String?, val lastOrderAmountMinor: Long?)
data class AccountOpenOrders(val count: Long, val amountMinor: Long)
/** Open orders are not an AR balance; withheld carries no figures. */
data class AccountSummary(val outletId: String, val asOfDate: String, val availability: String,
    val creditLimitMinor: Long?, val sales: AccountSales?, val openOrders: AccountOpenOrders?)

/** No org.json coercion of strings, booleans, fractional values or out-of-range integers. */
internal object TermsJson {
    fun keys(o: JSONObject, vararg names: String) { require(o.keys().asSequence().toSet() == names.toSet()) }
    fun text(o: JSONObject, key: String): String = (o.get(key) as? String)?.also { require(it.isNotEmpty()) }
        ?: error("Invalid $key")
    fun number(o: JSONObject, key: String): Long {
        val n = o.get(key)
        require(n is Number && n.toString().matches(Regex("-?[0-9]+")))
        return n.toString().toLongOrNull() ?: error("Invalid $key")
    }
    fun nullableNumber(o: JSONObject, key: String): Long? = if (o.get(key) == JSONObject.NULL) null else number(o, key)
    fun bool(o: JSONObject, key: String): Boolean = o.get(key) as? Boolean ?: error("Invalid $key")
    fun day(o: JSONObject, key: String): String = text(o, key).also {
        require(it.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && LocalDate.parse(it).toString() == it)
    }
}

object OrderTermsCodec {
    fun priceList(o: JSONObject): OrderPriceList {
        TermsJson.keys(o, "id", "code", "name", "currency", "sample")
        return OrderPriceList(TermsJson.text(o, "id"), TermsJson.text(o, "code"), TermsJson.text(o, "name"),
            TermsJson.text(o, "currency").also { require(it.matches(Regex("[A-Z]{3}"))) }, TermsJson.bool(o, "sample"))
    }
    fun decode(o: JSONObject): OrderTerms {
        TermsJson.keys(o, "outletId", "priceList", "lines")
        val list = if (o.get("priceList") == JSONObject.NULL) null else priceList(o.getJSONObject("priceList"))
        val a = o.getJSONArray("lines")
        require(a.length() <= 1800)
        val lines = (0 until a.length()).map { i ->
            val l = a.getJSONObject(i)
            TermsJson.keys(l, "productId", "uom", "unitPriceMinor")
            OrderUnit(TermsJson.text(l, "productId"), TermsJson.text(l, "uom").also { require(it.length in 1..20) },
                TermsJson.nullableNumber(l, "unitPriceMinor").also { require(it == null || it >= 0) })
        }
        require(lines.map { it.productId to it.uom }.distinct().size == lines.size)
        require(list != null || lines.all { it.unitPriceMinor == null })
        return OrderTerms(TermsJson.text(o, "outletId"), list, lines)
    }
    fun encodePriceList(l: OrderPriceList): JSONObject = JSONObject().put("id", l.id).put("code", l.code)
        .put("name", l.name).put("currency", l.currency).put("sample", l.sample)
    fun encode(t: OrderTerms): JSONObject = JSONObject().put("outletId", t.outletId)
        .put("priceList", t.priceList?.let(::encodePriceList) ?: JSONObject.NULL)
        .put("lines", JSONArray().apply { t.lines.forEach { l -> put(JSONObject().put("productId", l.productId)
            .put("uom", l.uom).put("unitPriceMinor", l.unitPriceMinor ?: JSONObject.NULL)) } })
}

object AccountSummaryCodec {
    fun decode(o: JSONObject): AccountSummary {
        TermsJson.keys(o, "outletId", "asOfDate", "availability", "creditLimitMinor", "sales", "openOrders")
        val day = TermsJson.day(o, "asOfDate")
        val availability = TermsJson.text(o, "availability").also { require(it in setOf("available", "withheld")) }
        val limit = TermsJson.nullableNumber(o, "creditLimitMinor").also { require(it == null || it >= 0) }
        val sales = if (o.get("sales") == JSONObject.NULL) null else o.getJSONObject("sales").let { s ->
            TermsJson.keys(s, "from", "to", "complete", "orders", "amountMinor", "recentOrders", "recentAmountMinor",
                "lastOrderDate", "lastOrderAmountMinor")
            val from = TermsJson.day(s, "from")
            val to = TermsJson.day(s, "to")
            require(from <= to && to == day)
            val orders = TermsJson.number(s, "orders").also { require(it >= 0) }
            val recent = TermsJson.number(s, "recentOrders").also { require(it in 0..orders) }
            val lastDay = if (s.get("lastOrderDate") == JSONObject.NULL) null else TermsJson.day(s, "lastOrderDate")
            val lastAmount = TermsJson.nullableNumber(s, "lastOrderAmountMinor")
            require((lastDay == null) == (lastAmount == null) && (lastDay == null || lastDay in from..to))
            AccountSales(from, to, TermsJson.bool(s, "complete"), orders, TermsJson.number(s, "amountMinor"),
                recent, TermsJson.number(s, "recentAmountMinor"), lastDay, lastAmount)
        }
        val open = if (o.get("openOrders") == JSONObject.NULL) null else o.getJSONObject("openOrders").let { s ->
            TermsJson.keys(s, "count", "amountMinor")
            AccountOpenOrders(TermsJson.number(s, "count").also { require(it >= 0) }, TermsJson.number(s, "amountMinor"))
        }
        require(availability != "withheld" || (limit == null && sales == null && open == null))
        return AccountSummary(TermsJson.text(o, "outletId"), day, availability, limit, sales, open)
    }
    fun encode(s: AccountSummary): JSONObject = JSONObject().put("outletId", s.outletId).put("asOfDate", s.asOfDate)
        .put("availability", s.availability).put("creditLimitMinor", s.creditLimitMinor ?: JSONObject.NULL)
        .put("sales", s.sales?.let { v -> JSONObject().put("from", v.from).put("to", v.to).put("complete", v.complete)
            .put("orders", v.orders).put("amountMinor", v.amountMinor).put("recentOrders", v.recentOrders)
            .put("recentAmountMinor", v.recentAmountMinor).put("lastOrderDate", v.lastOrderDate ?: JSONObject.NULL)
            .put("lastOrderAmountMinor", v.lastOrderAmountMinor ?: JSONObject.NULL) } ?: JSONObject.NULL)
        .put("openOrders", s.openOrders?.let { JSONObject().put("count", it.count).put("amountMinor", it.amountMinor) }
            ?: JSONObject.NULL)
}

/** Stored inside the promoted outlet JSON, inheriting its generation, encryption and scope. */
suspend fun FieldStore.orderTerms(outletId: String): OrderTerms? = outlets().firstOrNull { it.id == outletId }
    ?.let { JSONObject(it.json) }?.let { if (it.has("orderTerms")) OrderTermsCodec.decode(it.getJSONObject("orderTerms")) else null }
suspend fun FieldStore.accountSummary(outletId: String): AccountSummary? = outlets().firstOrNull { it.id == outletId }
    ?.let { JSONObject(it.json) }?.let { if (it.has("accountSummary")) AccountSummaryCodec.decode(it.getJSONObject("accountSummary")) else null }
