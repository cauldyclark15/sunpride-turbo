package com.sunpride.schemes

import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.math.BigInteger

/** Adapter quantities/prices only; every eligibility, mechanic, stacking and allocation runs in JS. */
data class SchemeLine(val productId: String, val uom: String, val quantityMilli: Long, val unitPriceMinor: Long?)
data class SchemeQuote(val result: JSONObject, val benefitMinor: Long, val authorityAllowed: Boolean)

object NativeSchemeQuote {
    fun evaluate(context: JSONObject, outletId: String, lines: List<SchemeLine>, now: Long, requireAuthority: Boolean): SchemeQuote {
        require(context.number("engineVersion") == NativeSchemes.VERSION.toLong() && context.getString("outletId") == outletId)
        require(now >= context.number("quotedAt") && now < context.number("validUntil"))
        val sourcePrices = context.getJSONArray("prices").objects()
        val wire = JSONArray(lines.map { line ->
            require(line.quantityMilli in 1..1_000_000_000L)
            val source = sourcePrices.singleOrNull { it.getString("productId") == line.productId && it.getString("uom") == line.uom }
            val price = source?.nullableLong("unitPriceCentavos")
            require(price == line.unitPriceMinor)
            val gross = price?.let { BigInteger.valueOf(it).multiply(BigInteger.valueOf(line.quantityMilli)).add(BigInteger.valueOf(500)).divide(BigInteger.valueOf(1000)).toString().toLong() }
            JSONObject().put("productId",line.productId).put("uom",line.uom)
                .put("quantity",BigDecimal.valueOf(line.quantityMilli,3).stripTrailingZeros().toPlainString())
                .put("unitPriceCentavos",price ?: JSONObject.NULL).put("lineTotalCentavos",gross ?: JSONObject.NULL)
                .put("priceListId",source?.opt("priceListId") ?: JSONObject.NULL)
        })
        val offers = context.getJSONArray("promotions").objects().filter {
            now >= it.number("effectiveFrom") && (it.isNull("effectiveTo") || now < it.number("effectiveTo"))
        }
        val result = NativeSchemes.quote(JSONObject().put("engineVersion",NativeSchemes.VERSION)
            .put("lines",wire).put("promotions",JSONArray(offers)).put("facts",JSONObject()))
        var benefit = BigInteger.ZERO
        for (promotion in result.getJSONArray("promotionsApplied").objects()) {
            var giftValue = BigInteger.ZERO
            for (gift in promotion.getJSONArray("freeGoods").objects()) {
                val source = sourcePrices.single { it.getString("productId") == gift.getString("productId") && it.getString("uom") == gift.getString("uom") }
                val value = BigInteger.valueOf(checkNotNull(source.nullableLong("unitPriceCentavos"))).multiply(BigInteger.valueOf(gift.getLong("quantity")))
                gift.put("referenceValueCentavos",value.toString().toLong())
                giftValue = giftValue.add(value)
            }
            promotion.put("freeGoodsValueCentavos",giftValue.toString().toLong())
            if(promotion.getLong("earnedCentavos")>0) require(context.opt("accountLinked")==true) { "Link this store to its SAP account before earning rebates" }
            benefit = benefit.add(giftValue).add(BigInteger.valueOf(promotion.getLong("discountCentavos"))).add(BigInteger.valueOf(promotion.getLong("earnedCentavos")))
        }
        val amount = benefit.toString().toLong()
        val matching = context.getJSONArray("authority").objects().filter {
            amount >= it.getString("minCentavos").toLong() && amount <= it.getString("maxCentavos").toLong()
        }
        val channel = context.opt("channelKey") as? String
        val exact = matching.filter { it.getString("channel") == channel }
        val rules = exact.ifEmpty { matching.filter { it.getString("channel") == "*" } }
        val allowed = amount == 0L || (!channel.isNullOrBlank() && rules.singleOrNull()?.getString("selfLimitCentavos")?.toLong()?.let { amount <= it } == true)
        check(!requireAuthority || allowed) { "Office discount approval is required before this sale" }
        return SchemeQuote(result,amount,allowed)
    }
    // Decimal parsing keeps exact overflow refusal on API 29 (BigInteger.longValueExact needs API 31).
    private fun JSONObject.number(key: String): Long {
        val value=get(key)
        require(value is Number && value.toString().matches(Regex("[0-9]+")))
        return value.toString().toLong().also { require(it in 0..9_007_199_254_740_991L) }
    }
    private fun JSONObject.nullableLong(key: String): Long? = if (isNull(key)) null else number(key)
    fun JSONArray.objects(): List<JSONObject> = (0 until length()).map(::getJSONObject)
}
